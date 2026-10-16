-- =============================================================================
-- Oportunidades: cada propiedad (o búsqueda) es un caso con sus propios datos,
-- estado y cita.
--
-- * app.contactos sigue guardando el caso ACTUAL (datos, estado y motivo), así
--   las funciones existentes no cambian; contactos.oportunidad_id apunta a él.
-- * Cuando la persona ofrece otra propiedad, app.nueva_oportunidad guarda el
--   caso actual en app.oportunidades y reinicia la calificación del contacto
--   (conserva nombre, teléfono y correo).
-- * Si pide revisarla en la reunión ya agendada, la oportunidad comparte esa
--   cita: se califica igual, no se ofrecen horarios y se deja una nota para el
--   asesor en GoHighLevel.
-- * Citas y evaluaciones quedan asociadas a su oportunidad.
-- =============================================================================

create table app.oportunidades (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  contacto_id         uuid not null,
  rol_codigo          app.codigo_rol,
  -- Foto del caso al cerrarlo; mientras es el caso actual, sus datos viven en app.contactos.
  datos               jsonb not null default '{}'::jsonb,
  estado              app.estado_contacto,
  motivo_estado       text,
  -- Reunión ya agendada (de otra oportunidad) en la que también se revisa esta.
  cita_compartida_id  uuid references app.citas (id) on delete set null,
  nota_asesor_en      timestamptz,
  creada_en           timestamptz not null default now(),
  cerrada_en          timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade
);
create index oportunidades_contacto on app.oportunidades (tenant_id, contacto_id);

alter table app.oportunidades enable row level security;
create policy oportunidades_lectura_miembros on app.oportunidades for select to authenticated
  using (tenant_id in (select app.tenants_del_usuario()));
create policy oportunidades_escritura_admin on app.oportunidades for all to authenticated
  using (app.es_admin_de(tenant_id))
  with check (app.es_admin_de(tenant_id));

alter table app.contactos add column oportunidad_id uuid;
alter table app.citas add column oportunidad_id uuid;
alter table app.evaluaciones_calificacion add column oportunidad_id uuid;

-- Cada contacto existente tiene una oportunidad: su caso actual.
insert into app.oportunidades (tenant_id, contacto_id, rol_codigo, creada_en)
select tenant_id, id, rol_origen, creado_en from app.contactos;
update app.contactos c set oportunidad_id = o.id
from app.oportunidades o where o.tenant_id = c.tenant_id and o.contacto_id = c.id;
update app.citas ci set oportunidad_id = c.oportunidad_id
from app.contactos c where c.tenant_id = ci.tenant_id and c.id = ci.contacto_id;
update app.evaluaciones_calificacion e set oportunidad_id = c.oportunidad_id
from app.contactos c where c.tenant_id = e.tenant_id and c.id = e.contacto_id;

-- Un contacto nuevo nace con su primera oportunidad.
create or replace function app.crear_oportunidad_inicial()
returns trigger
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into app.oportunidades (tenant_id, contacto_id, rol_codigo)
  values (new.tenant_id, new.id, new.rol_origen)
  returning id into v_id;
  update app.contactos set oportunidad_id = v_id where tenant_id = new.tenant_id and id = new.id;
  return null;
end;
$$;

create trigger contactos_oportunidad_inicial
  after insert on app.contactos
  for each row execute function app.crear_oportunidad_inicial();

-- Citas y evaluaciones toman la oportunidad actual del contacto.
create or replace function app.asignar_oportunidad()
returns trigger
language plpgsql
as $$
begin
  if new.oportunidad_id is null then
    select oportunidad_id into new.oportunidad_id
    from app.contactos where tenant_id = new.tenant_id and id = new.contacto_id;
  end if;
  return new;
end;
$$;

create trigger citas_oportunidad
  before insert on app.citas
  for each row execute function app.asignar_oportunidad();
create trigger evaluaciones_oportunidad
  before insert on app.evaluaciones_calificacion
  for each row execute function app.asignar_oportunidad();

-- -----------------------------------------------------------------------------
-- Nueva oportunidad y cita compartida
-- -----------------------------------------------------------------------------

create or replace function app.validar_transicion_contacto()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'en_calificacion' then
      raise exception 'Un contacto nuevo debe iniciar en en_calificacion (recibido: %)', new.estado
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.estado = old.estado then
    return new;
  end if;

  -- Otra propiedad (app.nueva_oportunidad): el contacto vuelve a calificación.
  if new.estado = 'en_calificacion' and current_setting('app.nueva_oportunidad', true) = 'on' then
    return new;
  end if;

  if not exists (
    select 1 from app.transiciones_estado where desde = old.estado and hacia = new.estado
  ) then
    raise exception 'Transición de estado no permitida: % -> %', old.estado, new.estado
      using errcode = 'check_violation';
  end if;

  -- AC 26 / AC 35 / AC 42: entregado_asesor exige una entrega registrada,
  -- que a su vez exige cita confirmada o excepción con motivo.
  if new.estado = 'entregado_asesor' and not exists (
    select 1 from app.entregas_asesor
    where tenant_id = new.tenant_id and contacto_id = new.id
  ) then
    raise exception 'No se puede marcar entregado_asesor sin una entrega registrada (cita confirmada o excepción)'
      using errcode = 'check_violation';
  end if;

  -- cita_confirmada exige una cita confirmada por el proveedor (AC 32).
  if new.estado = 'cita_confirmada' and not exists (
    select 1 from app.citas
    where tenant_id = new.tenant_id and contacto_id = new.id and estado = 'confirmada'
  ) then
    raise exception 'No se puede marcar cita_confirmada sin una cita confirmada por el proveedor'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Guarda el caso actual y reinicia la calificación del contacto. Devuelve
-- false si el caso actual aún no tiene datos de una propiedad (no hay nada
-- que separar).
create or replace function app.nueva_oportunidad(p_tenant uuid, p_conversacion uuid)
returns boolean
language plpgsql
as $$
declare
  v_conv  app.conversaciones;
  v_c     app.contactos;
  v_nueva uuid;
begin
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  select * into v_c from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;
  if v_c.estado in ('en_calificacion', 'informacion_incompleta') and not exists (
    select 1 from jsonb_object_keys(v_c.datos) k where k not in ('nombre', 'telefono', 'email')
  ) then
    return false;
  end if;

  update app.oportunidades
  set datos = v_c.datos, estado = v_c.estado, motivo_estado = v_c.motivo_estado,
      rol_codigo = coalesce(rol_codigo, v_conv.rol_codigo, v_c.rol_origen), cerrada_en = now()
  where tenant_id = p_tenant and id = v_c.oportunidad_id;

  insert into app.oportunidades (tenant_id, contacto_id, rol_codigo)
  values (p_tenant, v_c.id, coalesce(v_conv.rol_codigo, v_c.rol_origen))
  returning id into v_nueva;

  perform set_config('app.nueva_oportunidad', 'on', true);
  update app.contactos
  set oportunidad_id = v_nueva, estado = 'en_calificacion', motivo_estado = 'nueva_oportunidad',
      datos = (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
               from jsonb_each(v_c.datos) where key in ('nombre', 'telefono', 'email'))
  where tenant_id = p_tenant and id = v_c.id;
  perform set_config('app.nueva_oportunidad', 'off', true);

  update app.conversaciones set agenda = '{}'::jsonb where tenant_id = p_tenant and id = p_conversacion;
  return true;
end;
$$;

-- La oportunidad actual se revisará en la próxima reunión ya agendada de otra
-- oportunidad del contacto, si la hay y si esta no tiene cita propia.
create or replace function app.compartir_cita(p_tenant uuid, p_conversacion uuid)
returns boolean
language plpgsql
as $$
declare
  v_c    app.contactos;
  v_cita uuid;
begin
  select ct.* into v_c
  from app.contactos ct
  join app.conversaciones cv on cv.tenant_id = ct.tenant_id and cv.contacto_id = ct.id
  where cv.tenant_id = p_tenant and cv.id = p_conversacion;

  if exists (
    select 1 from app.citas
    where tenant_id = p_tenant and oportunidad_id = v_c.oportunidad_id
      and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
  ) then
    return false;
  end if;

  select id into v_cita from app.citas
  where tenant_id = p_tenant and contacto_id = v_c.id and oportunidad_id is distinct from v_c.oportunidad_id
    and estado in ('confirmada', 'reprogramada') and inicio > now()
  order by inicio
  limit 1;
  if v_cita is null then
    return false;
  end if;

  update app.oportunidades set cita_compartida_id = v_cita
  where tenant_id = p_tenant and id = v_c.oportunidad_id;
  update app.conversaciones set agenda = '{}'::jsonb where tenant_id = p_tenant and id = p_conversacion;
  return true;
end;
$$;

-- El extractor marca nueva_propiedad (otra propiedad u otra búsqueda) y
-- misma_cita (pide revisarla en la reunión ya agendada).
create or replace function app.registrar_datos_y_seleccion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
begin
  if p->'nueva_propiedad' = 'true'::jsonb then
    perform app.nueva_oportunidad(p_tenant, p_conversacion);
  end if;
  if p->'misma_cita' = 'true'::jsonb then
    perform app.compartir_cita(p_tenant, p_conversacion);
  end if;
  return app.registrar_datos(p_tenant, p_conversacion, p)
         || jsonb_build_object('seleccion', coalesce(p->'seleccion', 'null'::jsonb));
end;
$$;

-- Resultado de la nota para el asesor en GoHighLevel.
-- p: {ok: boolean, error?: {...}, evaluacion: {...}}
create or replace function app.registrar_nota_asesor(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_op uuid;
begin
  select ct.oportunidad_id into v_op
  from app.contactos ct
  join app.conversaciones cv on cv.tenant_id = ct.tenant_id and cv.contacto_id = ct.id
  where cv.tenant_id = p_tenant and cv.id = p_conversacion;

  if p->'ok' = 'true'::jsonb then
    update app.oportunidades set nota_asesor_en = now() where tenant_id = p_tenant and id = v_op;
  else
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'gohighlevel', 'operacion', 'nota_asesor',
      'mensaje', 'No fue posible dejar en GoHighLevel la nota de la propiedad adicional',
      'contexto', coalesce(p->'error', '{}'::jsonb))));
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', p->'evaluacion', 'resultado_nota', coalesce(p->'ok', 'false'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Contexto y evaluación por oportunidad
-- -----------------------------------------------------------------------------

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
  v_ctx := v_ctx || jsonb_build_object('oportunidad', (
    select jsonb_build_object(
      'id', o.id,
      'anteriores', (select count(*) from app.oportunidades x where x.tenant_id = p_tenant and x.contacto_id = o.contacto_id and x.id <> o.id),
      'nota_asesor_en', o.nota_asesor_en,
      'cita_compartida', (
        select jsonb_build_object('id', ci.id, 'inicio', ci.inicio, 'estado', ci.estado, 'modalidad', ci.modalidad)
        from app.citas ci
        where ci.id = o.cita_compartida_id and ci.estado in ('confirmada', 'reprogramada') and ci.inicio > now()))
    from app.oportunidades o
    where o.tenant_id = p_tenant and o.id = v_contacto.oportunidad_id));

  return v_ctx || jsonb_build_object('cita', (
    select jsonb_build_object('id', id, 'inicio', inicio, 'zona_horaria', zona_horaria,
                              'modalidad', modalidad, 'estado', estado)
    from app.citas
    where tenant_id = p_tenant and contacto_id = v_conv.contacto_id
      and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
      and oportunidad_id is not distinct from v_contacto.oportunidad_id
    order by creado_en desc
    limit 1));
end;
$$;

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

  -- Propiedad que se revisa en una reunión ya agendada: al calificar queda con esa cita.
  if v_eval->>'resultado' = 'calificado' and exists (
    select 1
    from app.contactos ct
    join app.oportunidades o on o.tenant_id = ct.tenant_id and o.id = ct.oportunidad_id
    join app.citas ci on ci.id = o.cita_compartida_id
    where ct.tenant_id = p_tenant and ct.id = v_conv.contacto_id
      and ci.estado in ('confirmada', 'reprogramada') and ci.inicio > now()
  ) then
    perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'calificado_pendiente_agendamiento');
    perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'cita_confirmada');
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', v_eval, 'estado_anterior', v_anterior);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.nueva_oportunidad(uuid, uuid)',
    'app.compartir_cita(uuid, uuid)',
    'app.registrar_datos_y_seleccion(uuid, uuid, jsonb)',
    'app.registrar_nota_asesor(uuid, uuid, jsonb)',
    'app.contexto_conversacion(uuid, uuid)',
    'app.guardar_evaluacion(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
