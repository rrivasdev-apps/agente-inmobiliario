-- =============================================================================
-- Funciones que usa el flujo de n8n (Etapa 2).
--
-- n8n solo llama a estas funciones: cada una recibe tenant_id y
-- conversacion_id resueltos por la propia BD a partir del canal, nunca del
-- LLM, y aplica las reglas en una sola transacción. Así el flujo queda
-- delgado y la lógica se prueba en tests/db sin n8n.
--
-- Secretos de Meta: se guardan en Supabase Vault con los nombres
-- 'meta_app_secret' y 'meta_verify_token'. Nunca salen de la BD: la firma y
-- el token se comparan aquí.
-- =============================================================================

-- Idempotencia de respuestas a comentarios de Instagram (AC 08, AC 40).
create unique index eventos_comentario_instagram_unico
  on app.eventos (tenant_id, clave_ejecucion)
  where operacion = 'comentario_instagram';

-- -----------------------------------------------------------------------------
-- Seguridad del webhook de Meta
-- -----------------------------------------------------------------------------

create or replace function app.secreto_vault(p_nombre text)
returns text
language sql
stable
security definer
set search_path = vault, pg_temp
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nombre limit 1;
$$;

-- X-Hub-Signature-256: "sha256=" + HMAC-SHA256 del cuerpo crudo con el App Secret.
create or replace function app.verificar_firma_meta(p_cuerpo bytea, p_firma text)
returns boolean
language plpgsql
stable
set search_path = app, extensions, public, pg_temp
as $$
declare
  v_secreto text := app.secreto_vault('meta_app_secret');
begin
  if v_secreto is null or p_cuerpo is null or p_firma is null or p_firma !~ '^sha256=[0-9a-f]{64}$' then
    return false;
  end if;
  return 'sha256=' || encode(hmac(p_cuerpo, convert_to(v_secreto, 'UTF8'), 'sha256'), 'hex') = p_firma;
end;
$$;

create or replace function app.verificar_token_meta(p_token text)
returns boolean
language sql
stable
as $$
  select coalesce(p_token <> '' and p_token = app.secreto_vault('meta_verify_token'), false);
$$;

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------

-- Dirección que se envía a Google Maps. Vacía hasta tener los tres datos.
create or replace function app.direccion_completa(p_datos jsonb)
returns text
language sql
immutable
as $$
  select case
    when coalesce(btrim(p_datos->>'direccion'), '') = ''
      or coalesce(btrim(p_datos->>'barrio'), '') = ''
      or coalesce(btrim(p_datos->>'ciudad'), '') = '' then ''
    else concat_ws(', ', btrim(p_datos->>'direccion'), btrim(p_datos->>'barrio'), btrim(p_datos->>'ciudad'))
  end;
$$;

-- Registra eventos [{nivel, proveedor, operacion, mensaje, contexto}] (AC 46, 47).
create or replace function app.registrar_eventos(p_tenant uuid, p_conversacion uuid, p_eventos jsonb)
returns void
language sql
as $$
  insert into app.eventos (tenant_id, nivel, proveedor, operacion, entidad, entidad_id, mensaje, contexto)
  select p_tenant,
         coalesce((e->>'nivel')::app.nivel_evento, 'error'),
         (e->>'proveedor')::app.proveedor_integracion,
         coalesce(e->>'operacion', 'n8n'),
         'conversacion',
         p_conversacion,
         coalesce(e->>'mensaje', 'Sin detalle'),
         coalesce(e->'contexto', '{}'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_eventos) = 'array' then p_eventos else '[]'::jsonb end) e;
$$;

-- -----------------------------------------------------------------------------
-- Contexto de la conversación: todo lo que el flujo necesita para un turno.
-- -----------------------------------------------------------------------------

create or replace function app.contexto_conversacion(p_tenant uuid, p_conversacion uuid)
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
    where v.tenant_id = p_tenant and v.conversacion_id = p_conversacion and v.direccion_original = v_direccion
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
                               where tenant_id = p_tenant and conversacion_id = p_conversacion),
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

-- -----------------------------------------------------------------------------
-- 1. Mensaje entrante
--
-- p: {tipo_canal, identificador_canal, id_externo, remitente_id, nombre,
--     texto, tipo_mensaje}
-- Devuelve {estado: 'ok' | 'duplicado' | 'canal_desconocido' | 'comentario', ...}
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

  insert into app.conversaciones (tenant_id, contacto_id, canal_id)
  values (v_canal.tenant_id, v_contacto, v_canal.id)
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
-- 2. Rol de la conversación según el clasificador (AC 06, AC 07)
-- p: {intencion: 'vender' | 'comprar' | 'ambigua', eventos?: [...]}
-- -----------------------------------------------------------------------------

create or replace function app.asignar_rol(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_rol app.codigo_rol := case p->>'intencion' when 'vender' then 'lucia' when 'comprar' then 'sonia' end;
  v_contacto uuid;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');
  if v_rol is not null then
    update app.conversaciones set rol_codigo = v_rol
    where tenant_id = p_tenant and id = p_conversacion and rol_codigo is null
    returning contacto_id into v_contacto;
    update app.contactos set rol_origen = v_rol
    where tenant_id = p_tenant and id = v_contacto and rol_origen is null;
  end if;
  return app.contexto_conversacion(p_tenant, p_conversacion);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Datos extraídos por el LLM
--
-- Solo se aceptan claves definidas en roles_agente.campos y valores del tipo
-- declarado; lo demás se descarta y se informa en 'ignorados'.
-- p: {datos: {...}, eventos?: [...]}
-- -----------------------------------------------------------------------------

create or replace function app.registrar_datos(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_campos    jsonb;
  v_contacto  uuid;
  v_aceptados jsonb := '{}'::jsonb;
  v_ignorados text[] := '{}';
  v_campo     jsonb;
  v_clave     text;
  v_valor     jsonb;
  v_valido    boolean;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');

  select r.campos, c.contacto_id into v_campos, v_contacto
  from app.conversaciones c
  join app.roles_agente r on r.tenant_id = c.tenant_id and r.codigo = c.rol_codigo
  where c.tenant_id = p_tenant and c.id = p_conversacion;
  if v_contacto is null then
    raise exception 'La conversación % no tiene rol asignado', p_conversacion;
  end if;

  for v_clave, v_valor in
    select key, value from jsonb_each(case when jsonb_typeof(p->'datos') = 'object' then p->'datos' else '{}'::jsonb end)
  loop
    select c into v_campo from jsonb_array_elements(v_campos) c where c->>'clave' = v_clave;
    if v_campo is null or v_valor = 'null'::jsonb or v_valor = '""'::jsonb then
      if v_campo is null then v_ignorados := v_ignorados || v_clave; end if;
      continue;
    end if;

    v_valido := case v_campo->>'tipo'
      when 'booleano' then jsonb_typeof(v_valor) = 'boolean'
      when 'numero'   then jsonb_typeof(v_valor) = 'number'
      when 'opcion'   then jsonb_typeof(v_valor) = 'string'
                           and lower(v_valor #>> '{}') in (select lower(o) from jsonb_array_elements_text(v_campo->'opciones') o)
      else jsonb_typeof(v_valor) in ('string', 'number')
    end;

    if v_valido then
      if v_campo->>'tipo' = 'opcion' then
        v_valor := to_jsonb(lower(v_valor #>> '{}'));
      elsif v_campo->>'tipo' = 'texto' then
        v_valor := to_jsonb(btrim(v_valor #>> '{}'));
      end if;
      v_aceptados := v_aceptados || jsonb_build_object(v_clave, v_valor);
    else
      v_ignorados := v_ignorados || v_clave;
    end if;
  end loop;

  update app.contactos
  set datos  = datos || v_aceptados,
      nombre = coalesce(v_aceptados->>'nombre', nombre)
  where tenant_id = p_tenant and id = v_contacto;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('registrados', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(v_aceptados) k),
                          'ignorados', to_jsonb(v_ignorados));
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Resultado de Google Maps (solo Lucía; el trigger de la tabla lo exige)
--
-- p: {resultado: 'verificada' | 'ambigua' | 'sin_resultados' | 'error',
--     direccion_normalizada, latitud, longitud, place_id, respuesta_proveedor}
-- 'sin_resultados' es ambigua la primera vez y no_verificada después de una
-- aclaración (docs/arquitectura.md).
-- -----------------------------------------------------------------------------

create or replace function app.registrar_verificacion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_contacto  app.contactos;
  v_resultado app.resultado_verificacion;
begin
  select ct.* into v_contacto
  from app.conversaciones c join app.contactos ct on ct.tenant_id = c.tenant_id and ct.id = c.contacto_id
  where c.tenant_id = p_tenant and c.id = p_conversacion;

  if p->>'resultado' = 'sin_resultados' then
    v_resultado := case when exists (
      select 1 from app.verificaciones_direccion
      where tenant_id = p_tenant and conversacion_id = p_conversacion and resultado <> 'error'
    ) then 'no_verificada' else 'ambigua' end;
  else
    v_resultado := (p->>'resultado')::app.resultado_verificacion;
  end if;

  insert into app.verificaciones_direccion (
    tenant_id, contacto_id, conversacion_id, direccion_original, direccion_normalizada,
    latitud, longitud, place_id, resultado, respuesta_proveedor)
  values (
    p_tenant, v_contacto.id, p_conversacion, app.direccion_completa(v_contacto.datos), p->>'direccion_normalizada',
    (p->>'latitud')::double precision, (p->>'longitud')::double precision, p->>'place_id', v_resultado,
    p->'respuesta_proveedor');

  if v_resultado = 'error' then
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'google_maps', 'operacion', 'verificar_direccion',
      'mensaje', 'Falló la consulta a Google Maps', 'contexto', p->'respuesta_proveedor')));
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion);
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Resultado de src/calificacion/evaluar.js y transición de estado
--
-- p: {evaluacion: {resultado, accion, campos_faltantes, reglas, motivo,
--     codigo_motivo}, eventos?: [...]}
-- La transición solo se aplica si la máquina de estados la permite; un
-- contacto que ya avanzó (p. ej. agendando) no retrocede por una evaluación.
-- -----------------------------------------------------------------------------

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
    tenant_id, conversacion_id, contacto_id, rol_codigo, resultado, campos_faltantes, criterios, motivo)
  values (
    p_tenant, p_conversacion, v_conv.contacto_id, v_conv.rol_codigo,
    (v_eval->>'resultado')::app.resultado_calificacion,
    coalesce((select array_agg(x) from jsonb_array_elements_text(v_eval->'campos_faltantes') x), '{}'),
    jsonb_build_object('accion', v_eval->'accion', 'codigo_motivo', v_eval->'codigo_motivo', 'reglas', coalesce(v_eval->'reglas', '[]'::jsonb)),
    v_eval->>'motivo');

  v_destino := case v_eval->>'resultado'
    when 'calificado' then 'calificado_pendiente_agendamiento'
    when 'no_calificado' then 'no_calificado'
    else 'informacion_incompleta'
  end;
  v_motivo := case when v_destino = 'no_calificado' then coalesce(v_eval->>'codigo_motivo', v_eval->>'motivo') end;

  if v_destino <> v_anterior and exists (
    select 1 from app.transiciones_estado where desde = v_anterior and hacia = v_destino
  ) then
    update app.contactos set estado = v_destino, motivo_estado = v_motivo
    where tenant_id = p_tenant and id = v_conv.contacto_id;
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', v_eval, 'estado_anterior', v_anterior);
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Respuesta enviada (o intentada) por Meta
-- p: {texto, plantilla?, id_externo?, enviado: bool, error?, eventos?: [...]}
-- -----------------------------------------------------------------------------

create or replace function app.registrar_respuesta(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_plantilla uuid;
  v_rol       app.codigo_rol;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');
  select rol_codigo into v_rol from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;

  if p->>'plantilla' is not null then
    select id into v_plantilla from app.plantillas
    where tenant_id = p_tenant and clave = p->>'plantilla' and (rol_codigo is null or rol_codigo = v_rol)
    order by (rol_codigo is null)
    limit 1;
  end if;

  insert into app.mensajes (tenant_id, conversacion_id, direccion, remitente, contenido, id_externo, plantilla_id, metadatos)
  values (p_tenant, p_conversacion, 'saliente', 'agente', p->>'texto', nullif(p->>'id_externo', ''), v_plantilla,
          jsonb_build_object('enviado', coalesce((p->>'enviado')::boolean, false), 'error', p->'error'));

  if coalesce((p->>'enviado')::boolean, false) then
    -- AC 09: el primer mensaje del agente lo presenta como asistente virtual.
    update app.conversaciones set identificado_como_virtual = true
    where tenant_id = p_tenant and id = p_conversacion and not identificado_como_virtual;
  else
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'meta', 'operacion', 'enviar_mensaje',
      'mensaje', 'Meta no aceptó la respuesta', 'contexto', coalesce(p->'error', '{}'::jsonb))));
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- Permisos: solo n8n (service_role / postgres) ejecuta estas funciones.
-- -----------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.secreto_vault(text)',
    'app.verificar_firma_meta(bytea, text)',
    'app.verificar_token_meta(text)',
    'app.direccion_completa(jsonb)',
    'app.registrar_eventos(uuid, uuid, jsonb)',
    'app.contexto_conversacion(uuid, uuid)',
    'app.recibir_mensaje(jsonb)',
    'app.asignar_rol(uuid, uuid, jsonb)',
    'app.registrar_datos(uuid, uuid, jsonb)',
    'app.registrar_verificacion(uuid, uuid, jsonb)',
    'app.guardar_evaluacion(uuid, uuid, jsonb)',
    'app.registrar_respuesta(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
