-- =============================================================================
-- Cierre de conversaciones por inactividad y saludo de retorno.
--
-- * Una conversación se cierra tras `parametros.conversacion.cierre_inactividad_horas`
--   (48 por defecto) sin mensajes: al recibir el siguiente mensaje y, si pg_cron
--   está disponible, cada hora.
-- * El mensaje que llega después abre una conversación nueva que conserva el
--   rol y apunta a la anterior. Su primer turno trae `retorno` en el contexto
--   para que el agente salude por el nombre y retome lo pendiente.
-- * La verificación de la dirección se busca por contacto, no por
--   conversación: quien regresa no se vuelve a geocodificar.
-- * Un no calificado que corrige un dato se vuelve a evaluar (antes quedaba
--   en no_calificado aunque calificara y agendara).
-- =============================================================================

alter table app.conversaciones
  add column cerrada_en timestamptz,
  add column motivo_cierre text,
  add column conversacion_anterior_id uuid;

-- -----------------------------------------------------------------------------
-- Inactividad
-- -----------------------------------------------------------------------------

create or replace function app.ultima_actividad(p_tenant uuid, p_conversacion uuid)
returns timestamptz
language sql
stable
as $$
  select coalesce(
    (select max(creado_en) from app.mensajes where tenant_id = p_tenant and conversacion_id = p_conversacion),
    (select creado_en from app.conversaciones where tenant_id = p_tenant and id = p_conversacion));
$$;

create or replace function app.conversacion_inactiva(p_tenant uuid, p_conversacion uuid)
returns boolean
language sql
stable
as $$
  select app.ultima_actividad(p_tenant, p_conversacion) < now() - interval '1 hour' * coalesce(
    (select (parametros->'conversacion'->>'cierre_inactividad_horas')::numeric from app.tenants where id = p_tenant),
    48);
$$;

-- Cierra todas las conversaciones inactivas. Devuelve cuántas cerró.
create or replace function app.cerrar_conversaciones_inactivas()
returns integer
language plpgsql
as $$
declare
  v_n integer;
begin
  update app.conversaciones c
  set abierta = false, cerrada_en = now(), motivo_cierre = 'inactividad'
  where c.abierta and app.conversacion_inactiva(c.tenant_id, c.id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Cada hora con pg_cron, si el servidor lo ofrece (Supabase sí; el Postgres
-- de las pruebas locales no). Sin pg_cron, se cierran al llegar el siguiente
-- mensaje.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    execute $c$select cron.schedule('cerrar-conversaciones-inactivas', '17 * * * *',
                                   'select app.cerrar_conversaciones_inactivas()')$c$;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Mensaje entrante: cierra la conversación inactiva y abre la de retorno
-- -----------------------------------------------------------------------------

create or replace function app.recibir_mensaje(p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_tipo      app.tipo_canal := (p->>'tipo_canal')::app.tipo_canal;
  v_canal     app.canales;
  v_telefono  text;
  v_contacto  uuid;
  v_conv      uuid;
  v_mensaje   uuid;
  v_plantilla text;
  v_anterior  uuid;
  v_rol_previo app.codigo_rol;
begin
  -- AC 05: el canal identifica al tenant sin ambigüedad.
  select c.* into v_canal
  from app.canales c join app.tenants t on t.id = c.tenant_id
  where c.tipo = v_tipo and c.identificador_externo = p->>'identificador_canal' and c.activo and t.activo;
  if not found then
    return jsonb_build_object('estado', 'canal_desconocido');
  end if;

  -- AC 08: un comentario solo recibe la invitación a escribir por DM.
  if v_tipo = 'instagram_comentario' then
    insert into app.eventos (tenant_id, nivel, proveedor, operacion, mensaje, clave_ejecucion, contexto)
    values (v_canal.tenant_id, 'info', 'meta', 'comentario_instagram', 'Respuesta a comentario', p->>'id_externo',
            jsonb_build_object('texto', p->>'texto', 'remitente_id', p->>'remitente_id'))
    on conflict (tenant_id, clave_ejecucion) where operacion = 'comentario_instagram' do nothing;
    if not found then
      return jsonb_build_object('estado', 'duplicado');
    end if;
    select texto into v_plantilla from app.plantillas
    where tenant_id = v_canal.tenant_id and rol_codigo is null and clave = 'comentario_instagram';
    return jsonb_build_object('estado', 'comentario', 'tenant_id', v_canal.tenant_id,
                              'comentario_id', p->>'id_externo', 'texto', v_plantilla);
  end if;

  -- Contacto: en WhatsApp por teléfono (E.164), en Instagram por su id.
  if v_tipo = 'whatsapp' then
    v_telefono := '+' || regexp_replace(p->>'remitente_id', '\D', '', 'g');
    insert into app.contactos (tenant_id, nombre, telefono, canal_origen, datos)
    values (v_canal.tenant_id, nullif(p->>'nombre', ''), v_telefono, v_tipo, jsonb_build_object('telefono', v_telefono))
    on conflict (tenant_id, telefono) where telefono is not null do nothing;
    select id into v_contacto from app.contactos where tenant_id = v_canal.tenant_id and telefono = v_telefono;
  else
    insert into app.contactos (tenant_id, nombre, instagram_id, canal_origen)
    values (v_canal.tenant_id, nullif(p->>'nombre', ''), p->>'remitente_id', v_tipo)
    on conflict (tenant_id, instagram_id) where instagram_id is not null do nothing;
    select id into v_contacto from app.contactos
    where tenant_id = v_canal.tenant_id and instagram_id = p->>'remitente_id';
  end if;

  -- Una conversación sin mensajes durante las horas configuradas se cierra.
  -- El mensaje nuevo abre otra que conserva el rol y apunta a la anterior,
  -- para que el agente salude a quien regresa.
  update app.conversaciones c
  set abierta = false, cerrada_en = now(), motivo_cierre = 'inactividad'
  where c.tenant_id = v_canal.tenant_id and c.contacto_id = v_contacto and c.canal_id = v_canal.id and c.abierta
    and app.conversacion_inactiva(c.tenant_id, c.id);

  select id, rol_codigo into v_anterior, v_rol_previo
  from app.conversaciones
  where tenant_id = v_canal.tenant_id and contacto_id = v_contacto and not abierta
  order by coalesce(cerrada_en, creado_en) desc
  limit 1;

  insert into app.conversaciones (tenant_id, contacto_id, canal_id, rol_codigo, conversacion_anterior_id)
  values (v_canal.tenant_id, v_contacto, v_canal.id, v_rol_previo, v_anterior)
  on conflict (tenant_id, contacto_id, canal_id) where abierta do nothing;
  select id into v_conv from app.conversaciones
  where tenant_id = v_canal.tenant_id and contacto_id = v_contacto and canal_id = v_canal.id and abierta;

  -- Idempotencia: Meta reintenta webhooks; el mismo id_externo no se procesa dos veces.
  insert into app.mensajes (tenant_id, conversacion_id, direccion, remitente, contenido, id_externo, metadatos)
  values (v_canal.tenant_id, v_conv, 'entrante', 'contacto', coalesce(nullif(p->>'texto', ''), '[mensaje sin texto]'),
          p->>'id_externo', jsonb_build_object('tipo_mensaje', coalesce(p->>'tipo_mensaje', 'text')))
  on conflict (tenant_id, id_externo) where id_externo is not null do nothing
  returning id into v_mensaje;
  if v_mensaje is null then
    return jsonb_build_object('estado', 'duplicado');
  end if;

  update app.conversaciones set ultimo_mensaje_contacto_en = now()
  where tenant_id = v_canal.tenant_id and id = v_conv;

  return app.contexto_conversacion(v_canal.tenant_id, v_conv) || jsonb_build_object('estado', 'ok');
end;
$$;

-- -----------------------------------------------------------------------------
-- Contexto: verificación por contacto y datos de retorno
-- -----------------------------------------------------------------------------

create or replace function app.contexto_base(p_tenant uuid, p_conversacion uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_conv      app.conversaciones;
  v_contacto  app.contactos;
  v_canal     app.canales;
  v_tenant    app.tenants;
  v_rol       app.roles_agente;
  v_direccion text;
  v_verif     jsonb;
begin
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  if not found then
    raise exception 'Conversación % no existe en el tenant %', p_conversacion, p_tenant;
  end if;
  select * into v_contacto from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;
  select * into v_canal from app.canales where tenant_id = p_tenant and id = v_conv.canal_id;
  select * into v_tenant from app.tenants where id = p_tenant;
  if v_conv.rol_codigo is not null then
    select * into v_rol from app.roles_agente
    where tenant_id = p_tenant and codigo = v_conv.rol_codigo and activo;
  end if;

  v_direccion := app.direccion_completa(v_contacto.datos);
  if v_rol.requiere_verificacion_direccion and v_direccion <> '' then
    select jsonb_build_object(
             'resultado', v.resultado,
             'direccion_original', v.direccion_original,
             'direccion_normalizada', v.direccion_normalizada)
      into v_verif
    from app.verificaciones_direccion v
    where v.tenant_id = p_tenant and v.contacto_id = v_contacto.id and v.direccion_original = v_direccion
    order by v.creado_en desc, v.id desc
    limit 1;
  end if;

  return jsonb_build_object(
    'tenant', jsonb_build_object('id', v_tenant.id, 'nombre', v_tenant.nombre, 'zona_horaria', v_tenant.zona_horaria),
    'canal', jsonb_build_object('id', v_canal.id, 'tipo', v_canal.tipo, 'identificador_externo', v_canal.identificador_externo),
    'contacto', jsonb_build_object(
      'id', v_contacto.id, 'nombre', v_contacto.nombre, 'telefono', v_contacto.telefono,
      'instagram_id', v_contacto.instagram_id, 'estado', v_contacto.estado, 'datos', v_contacto.datos),
    'conversacion', jsonb_build_object(
      'id', v_conv.id, 'rol_codigo', v_conv.rol_codigo,
      'identificado_como_virtual', v_conv.identificado_como_virtual),
    'rol', case when v_rol.id is null then null else jsonb_build_object(
      'codigo', v_rol.codigo, 'nombre_visible', v_rol.nombre_visible, 'prompt_sistema', v_rol.prompt_sistema,
      'campos', v_rol.campos, 'criterios', v_rol.criterios,
      'requiere_verificacion_direccion', v_rol.requiere_verificacion_direccion) end,
    'direccion_a_verificar', nullif(v_direccion, ''),
    'verificacion', v_verif,
    -- Se consulta Google Maps si hay dirección completa sin verificar, o si la
    -- última consulta de esa misma dirección falló (AC 47: se reintenta).
    'verificacion_pendiente', coalesce(v_rol.requiere_verificacion_direccion, false)
                              and v_direccion <> ''
                              and (v_verif is null or v_verif->>'resultado' = 'error'),
    'verificaciones_previas', (select count(*) from app.verificaciones_direccion
                               where tenant_id = p_tenant and contacto_id = v_contacto.id),
    'plantillas', coalesce((
      select jsonb_object_agg(clave, texto) from (
        select distinct on (clave) clave, texto
        from app.plantillas
        where tenant_id = p_tenant
          and (rol_codigo is null or rol_codigo = v_conv.rol_codigo)
        order by clave, (rol_codigo is null)
      ) p), '{}'::jsonb),
    'integraciones', coalesce((
      select jsonb_object_agg(categoria, configuracion)
      from app.integraciones where tenant_id = p_tenant and activo), '{}'::jsonb),
    'historial', coalesce((
      select jsonb_agg(jsonb_build_object('direccion', direccion, 'remitente', remitente, 'contenido', contenido)
                       order by creado_en, id)
      from (
        select * from app.mensajes
        where tenant_id = p_tenant and conversacion_id = p_conversacion
        order by creado_en desc, id desc
        limit 30
      ) m), '[]'::jsonb)
  );
end;
$$;

create or replace function app.contexto_conversacion(p_tenant uuid, p_conversacion uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_ctx      jsonb := app.contexto_base(p_tenant, p_conversacion);
  v_conv     app.conversaciones;
  v_contacto app.contactos;
  v_rol      app.roles_agente;
  v_ultimo   timestamptz;
  v_retorno  jsonb;
begin
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  select * into v_contacto from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;
  select * into v_rol from app.roles_agente where tenant_id = p_tenant and codigo = v_conv.rol_codigo;

  v_ctx := jsonb_set(v_ctx, '{contacto}', v_ctx->'contacto' || jsonb_build_object(
    'ghl_contact_id', v_contacto.ghl_contact_id,
    'email', v_contacto.email,
    'canal_origen', v_contacto.canal_origen));
  v_ctx := jsonb_set(v_ctx, '{conversacion}', v_ctx->'conversacion' || jsonb_build_object('agenda', v_conv.agenda));
  v_ctx := jsonb_set(v_ctx, '{tenant}', v_ctx->'tenant' || jsonb_build_object(
    'parametros', (select parametros from app.tenants where id = p_tenant)));
  if v_ctx->'rol' <> 'null'::jsonb then
    v_ctx := jsonb_set(v_ctx, '{rol}', v_ctx->'rol' || jsonb_build_object('etiqueta_crm', v_rol.etiqueta_crm));
  end if;

  -- Primer mensaje de una conversación que reemplaza a otra cerrada por
  -- inactividad: el agente saluda a quien regresa.
  if v_conv.conversacion_anterior_id is not null and (
    select count(*) from app.mensajes
    where tenant_id = p_tenant and conversacion_id = p_conversacion and direccion = 'entrante') <= 1 then
    v_ultimo := app.ultima_actividad(p_tenant, v_conv.conversacion_anterior_id);
    v_retorno := jsonb_build_object(
      'ultimo_contacto_en', v_ultimo,
      'horas_sin_contacto', floor(extract(epoch from (v_conv.creado_en - v_ultimo)) / 3600),
      'ahora', now());
  end if;
  v_ctx := v_ctx || jsonb_build_object('retorno', v_retorno);

  return v_ctx || jsonb_build_object('cita', (
    select jsonb_build_object('id', id, 'inicio', inicio, 'zona_horaria', zona_horaria,
                              'modalidad', modalidad, 'estado', estado)
    from app.citas
    where tenant_id = p_tenant and contacto_id = v_conv.contacto_id
      and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
    order by creado_en desc
    limit 1));
end;
$$;

-- -----------------------------------------------------------------------------
-- Un no calificado se puede volver a evaluar
-- -----------------------------------------------------------------------------

insert into app.transiciones_estado (desde, hacia) values
  ('no_calificado', 'informacion_incompleta'),
  ('no_calificado', 'calificado_pendiente_agendamiento'),
  ('no_calificado', 'nutricion')
on conflict do nothing;

create or replace function app.guardar_evaluacion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_eval     jsonb := p->'evaluacion';
  v_conv     app.conversaciones;
  v_anterior app.estado_contacto;
  v_destino  app.estado_contacto;
  v_motivo   text;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');

  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  select estado into v_anterior from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;

  insert into app.evaluaciones_calificacion (
    tenant_id, conversacion_id, contacto_id, rol_codigo, resultado, campos_faltantes, criterios, motivo, prioridad)
  values (
    p_tenant, p_conversacion, v_conv.contacto_id, v_conv.rol_codigo,
    (v_eval->>'resultado')::app.resultado_calificacion,
    coalesce((select array_agg(x) from jsonb_array_elements_text(v_eval->'campos_faltantes') x), '{}'),
    jsonb_build_object('accion', v_eval->'accion', 'codigo_motivo', v_eval->'codigo_motivo', 'reglas', coalesce(v_eval->'reglas', '[]'::jsonb)),
    v_eval->>'motivo', v_eval->>'prioridad');

  v_destino := case v_eval->>'resultado'
    when 'calificado' then
      case when v_eval->>'prioridad' = 'baja' then 'nutricion' else 'calificado_pendiente_agendamiento' end
    when 'no_calificado' then 'no_calificado'
    else 'informacion_incompleta'
  end;
  v_motivo := case when v_destino = 'no_calificado' then coalesce(v_eval->>'codigo_motivo', v_eval->>'motivo') end;

  -- La evaluación solo mueve el estado durante la calificación; después, el
  -- agendamiento (registrar_oferta, registrar_cita) es dueño del estado.
  -- Un no calificado que corrige un dato (otra ciudad, otro inmueble) se
  -- vuelve a evaluar.
  if v_anterior in ('en_calificacion', 'informacion_incompleta', 'nutricion', 'no_calificado')
     and v_destino <> v_anterior and exists (
    select 1 from app.transiciones_estado where desde = v_anterior and hacia = v_destino
  ) then
    update app.contactos set estado = v_destino, motivo_estado = v_motivo
    where tenant_id = p_tenant and id = v_conv.contacto_id;
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', v_eval, 'estado_anterior', v_anterior);
end;
$$;

-- Contactos que quedaron en no_calificado aunque tienen una cita confirmada.
update app.contactos c set estado = 'calificado_pendiente_agendamiento', motivo_estado = null
where c.estado = 'no_calificado' and exists (
  select 1 from app.citas ci
  where ci.tenant_id = c.tenant_id and ci.contacto_id = c.id and ci.estado = 'confirmada');
update app.contactos c set estado = 'cita_confirmada'
where c.estado = 'calificado_pendiente_agendamiento' and exists (
  select 1 from app.citas ci
  where ci.tenant_id = c.tenant_id and ci.contacto_id = c.id and ci.estado = 'confirmada');

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.ultima_actividad(uuid, uuid)',
    'app.conversacion_inactiva(uuid, uuid)',
    'app.cerrar_conversaciones_inactivas()'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
