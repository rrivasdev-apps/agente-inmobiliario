-- =============================================================================
-- Agente de captación y calificación inmobiliaria — Esquema inicial (Fase 1)
--
-- Principios (PRD §8.2 y §9.1):
--   * Toda entidad de negocio lleva tenant_id obligatorio (AC 01).
--   * Las referencias entre tablas usan claves compuestas (tenant_id, id), de
--     modo que es imposible enlazar registros de dos tenants distintos (AC 02).
--   * RLS activo en todas las tablas: un usuario autenticado solo ve los
--     tenants a los que pertenece. n8n usa service_role y DEBE filtrar siempre
--     por tenant_id.
--   * Un contacto solo se entrega al asesor con una cita confirmada por el
--     proveedor o con una excepción operativa registrada (AC 26, 35, 42).
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Tipos enumerados
-- -----------------------------------------------------------------------------

-- PRD §8: estados del proceso.
create type app.estado_contacto as enum (
  'en_calificacion',
  'informacion_incompleta',
  'no_calificado',
  'archivado',
  'calificado_pendiente_agendamiento',
  'seleccion_pendiente_confirmacion',
  'sin_disponibilidad',
  'error_agendamiento',
  'cita_confirmada',
  'entregado_asesor',
  'cita_reprogramada',
  'cita_cancelada',
  'atencion_comercial_iniciada'
);

create type app.tipo_canal as enum (
  'whatsapp',
  'instagram_dm',
  'instagram_comentario',
  'facebook_messenger'          -- pendiente de confirmación (PRD §10)
);

create type app.codigo_rol as enum ('lucia', 'sonia');

create type app.rol_miembro as enum (
  'admin_plataforma',
  'admin_operacion',
  'asesor'
);

create type app.categoria_integracion as enum (
  'crm',
  'calendario',
  'geocodificacion',
  'llm',
  'mensajeria'
);

create type app.proveedor_integracion as enum (
  'gohighlevel',
  'gohighlevel_calendar',
  'calendly',
  'google_calendar',
  'google_maps',
  'openai',
  'meta'
);

create type app.direccion_mensaje as enum ('entrante', 'saliente');

create type app.remitente_mensaje as enum ('contacto', 'agente', 'sistema', 'asesor');

create type app.resultado_verificacion as enum (
  'verificada',
  'ambigua',
  'no_verificada',
  'error'
);

create type app.resultado_calificacion as enum (
  'calificado',
  'no_calificado',
  'informacion_incompleta'
);

create type app.estado_cita as enum (
  'seleccion_pendiente',
  'confirmada',
  'reprogramada',
  'cancelada',
  'error'
);

create type app.nivel_evento as enum ('info', 'advertencia', 'error');

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------

create or replace function app.tocar_actualizado()
returns trigger
language plpgsql
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tenants y membresía
-- -----------------------------------------------------------------------------

create table app.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9-]+$'),
  nombre          text not null,
  zona_horaria    text not null default 'America/Bogota',
  mercado         text,
  activo          boolean not null default true,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

create table app.miembros_tenant (
  tenant_id   uuid not null references app.tenants (id) on delete cascade,
  user_id     uuid not null,          -- auth.users.id
  rol         app.rol_miembro not null,
  creado_en   timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- Tenants a los que pertenece el usuario autenticado actual.
create or replace function app.tenants_del_usuario()
returns setof uuid
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select tenant_id from app.miembros_tenant where user_id = auth.uid();
$$;

create or replace function app.es_admin_de(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.miembros_tenant
    where user_id = auth.uid()
      and tenant_id = p_tenant
      and rol in ('admin_plataforma', 'admin_operacion')
  );
$$;

-- -----------------------------------------------------------------------------
-- Configuración por tenant (AC 03: prompt, campos, criterios, verificación,
-- etiqueta CRM, calendario y subcuenta de GoHighLevel salen de aquí).
-- -----------------------------------------------------------------------------

create table app.canales (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references app.tenants (id) on delete cascade,
  tipo                  app.tipo_canal not null,
  -- phone_number_id de WhatsApp Cloud API, id de la cuenta de Instagram, etc.
  identificador_externo text not null,
  nombre                text,
  activo                boolean not null default true,
  creado_en             timestamptz not null default now(),
  unique (tenant_id, id),
  -- Un mensaje entrante identifica sin ambigüedad a su tenant (AC 05).
  unique (tipo, identificador_externo)
);

create table app.roles_agente (
  id                              uuid primary key default gen_random_uuid(),
  tenant_id                       uuid not null references app.tenants (id) on delete cascade,
  codigo                          app.codigo_rol not null,
  nombre_visible                  text not null,
  tipo_contacto                   text not null check (tipo_contacto in ('propietario', 'comprador')),
  prompt_sistema                  text not null,
  -- Definición de campos a capturar: [{clave, etiqueta, tipo, obligatorio, opciones?}]
  campos                          jsonb not null default '[]'::jsonb,
  -- Criterios evaluados por src/calificacion/evaluar.js
  criterios                       jsonb not null default '{}'::jsonb,
  requiere_verificacion_direccion boolean not null default false,
  etiqueta_crm                    text not null,
  activo                          boolean not null default true,
  creado_en                       timestamptz not null default now(),
  actualizado_en                  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, codigo),
  check (jsonb_typeof(campos) = 'array'),
  check (jsonb_typeof(criterios) = 'object'),
  -- Lucía siempre verifica dirección; Sonia nunca (AC 13, AC 20).
  check (
    (codigo = 'lucia' and requiere_verificacion_direccion)
    or (codigo = 'sonia' and not requiere_verificacion_direccion)
  )
);

create trigger roles_agente_actualizado
  before update on app.roles_agente
  for each row execute function app.tocar_actualizado();

-- Integraciones: solo configuración NO secreta y una referencia a la
-- credencial (p. ej. nombre de la credencial en n8n o id en Supabase Vault).
create table app.integraciones (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references app.tenants (id) on delete cascade,
  categoria        app.categoria_integracion not null,
  proveedor        app.proveedor_integracion not null,
  -- p. ej. {"location_id": "...", "calendar_id": "...", "pipeline_id": "..."}
  configuracion    jsonb not null default '{}'::jsonb,
  referencia_credencial text,
  activo           boolean not null default true,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now(),
  unique (tenant_id, id),
  check (jsonb_typeof(configuracion) = 'object')
);

-- Una sola integración activa por categoría y tenant (AC 31: el calendario
-- se cambia por tenant sin tocar el flujo).
create unique index integraciones_una_activa_por_categoria
  on app.integraciones (tenant_id, categoria)
  where activo;

create trigger integraciones_actualizado
  before update on app.integraciones
  for each row execute function app.tocar_actualizado();

create table app.plantillas (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references app.tenants (id) on delete cascade,
  rol_codigo                app.codigo_rol,          -- null = común a ambos roles
  clave                     text not null,
  texto                     text not null,
  requiere_aprobacion_meta  boolean not null default false,
  nombre_plantilla_meta     text,
  aprobada_meta             boolean not null default false,
  creado_en                 timestamptz not null default now(),
  actualizado_en            timestamptz not null default now(),
  unique (tenant_id, id)
);

create unique index plantillas_clave_por_rol
  on app.plantillas (tenant_id, rol_codigo, clave) where rol_codigo is not null;
create unique index plantillas_clave_comun
  on app.plantillas (tenant_id, clave) where rol_codigo is null;

create trigger plantillas_actualizado
  before update on app.plantillas
  for each row execute function app.tocar_actualizado();

create table app.asesores (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references app.tenants (id) on delete cascade,
  nombre       text not null,
  email        text,
  telefono     text,
  ghl_user_id  text,
  user_id      uuid,               -- auth.users.id si el asesor accede al panel
  activo       boolean not null default true,
  creado_en    timestamptz not null default now(),
  unique (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Contactos, conversaciones y mensajes
-- -----------------------------------------------------------------------------

create table app.contactos (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references app.tenants (id) on delete cascade,
  nombre             text,
  telefono           text check (telefono is null or telefono ~ '^\+[1-9][0-9]{6,14}$'), -- E.164
  email              text,
  instagram_id       text,
  rol_origen         app.codigo_rol,
  canal_origen       app.tipo_canal not null,
  estado             app.estado_contacto not null default 'en_calificacion',
  motivo_estado      text,
  -- Datos capturados según roles_agente.campos.
  datos              jsonb not null default '{}'::jsonb,
  ghl_contact_id     text,
  asesor_id          uuid,
  consentimiento_en  timestamptz,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, asesor_id) references app.asesores (tenant_id, id),
  check (jsonb_typeof(datos) = 'object'),
  -- AC 43: todo no calificado / archivado conserva un motivo legible.
  check (estado not in ('no_calificado', 'archivado') or coalesce(btrim(motivo_estado), '') <> '')
);

-- Política de duplicados (AC 23): teléfono y, cuando exista, correo.
create unique index contactos_telefono_unico
  on app.contactos (tenant_id, telefono) where telefono is not null;
create unique index contactos_email_unico
  on app.contactos (tenant_id, lower(email)) where email is not null;
create unique index contactos_instagram_unico
  on app.contactos (tenant_id, instagram_id) where instagram_id is not null;
create unique index contactos_ghl_unico
  on app.contactos (tenant_id, ghl_contact_id) where ghl_contact_id is not null;
create index contactos_estado on app.contactos (tenant_id, estado);

create trigger contactos_actualizado
  before update on app.contactos
  for each row execute function app.tocar_actualizado();

create table app.conversaciones (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references app.tenants (id) on delete cascade,
  contacto_id               uuid not null,
  canal_id                  uuid not null,
  rol_codigo                app.codigo_rol,          -- null mientras la intención es ambigua
  abierta                   boolean not null default true,
  resumen                   text,
  -- Ventana de atención de Meta (AC 45): último mensaje del contacto.
  ultimo_mensaje_contacto_en timestamptz,
  identificado_como_virtual boolean not null default false,   -- AC 09
  creado_en                 timestamptz not null default now(),
  actualizado_en            timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade,
  foreign key (tenant_id, canal_id) references app.canales (tenant_id, id)
);

create unique index conversaciones_una_abierta
  on app.conversaciones (tenant_id, contacto_id, canal_id) where abierta;

create trigger conversaciones_actualizado
  before update on app.conversaciones
  for each row execute function app.tocar_actualizado();

create table app.mensajes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  conversacion_id  uuid not null,
  direccion        app.direccion_mensaje not null,
  remitente        app.remitente_mensaje not null,
  contenido        text not null,
  -- Id del mensaje en Meta; evita procesar dos veces el mismo webhook.
  id_externo       text,
  plantilla_id     uuid,
  metadatos        jsonb not null default '{}'::jsonb,
  creado_en        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversacion_id) references app.conversaciones (tenant_id, id) on delete cascade,
  foreign key (tenant_id, plantilla_id) references app.plantillas (tenant_id, id)
);

create unique index mensajes_id_externo_unico
  on app.mensajes (tenant_id, id_externo) where id_externo is not null;
create index mensajes_por_conversacion on app.mensajes (tenant_id, conversacion_id, creado_en);

-- -----------------------------------------------------------------------------
-- Verificación de dirección y calificación
-- -----------------------------------------------------------------------------

create table app.verificaciones_direccion (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null,
  contacto_id            uuid not null,
  conversacion_id        uuid not null,
  direccion_original     text not null,             -- AC 14
  direccion_normalizada  text,
  latitud                double precision,
  longitud               double precision,
  place_id               text,
  resultado              app.resultado_verificacion not null,
  respuesta_proveedor    jsonb,
  creado_en              timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade,
  foreign key (tenant_id, conversacion_id) references app.conversaciones (tenant_id, id) on delete cascade
);

-- Sonia nunca verifica direcciones (AC 20).
create or replace function app.validar_verificacion_solo_lucia()
returns trigger
language plpgsql
as $$
declare
  v_rol app.codigo_rol;
begin
  select rol_codigo into v_rol
  from app.conversaciones
  where tenant_id = new.tenant_id and id = new.conversacion_id;

  if v_rol is distinct from 'lucia' then
    raise exception 'Solo las conversaciones de Lucía pueden verificar direcciones (rol actual: %)', v_rol
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger verificaciones_solo_lucia
  before insert on app.verificaciones_direccion
  for each row execute function app.validar_verificacion_solo_lucia();

create table app.evaluaciones_calificacion (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  conversacion_id    uuid not null,
  contacto_id        uuid not null,
  rol_codigo         app.codigo_rol not null,
  resultado          app.resultado_calificacion not null,
  campos_faltantes   text[] not null default '{}',
  criterios          jsonb not null,        -- detalle por regla, para auditoría
  motivo             text,
  creado_en          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversacion_id) references app.conversaciones (tenant_id, id) on delete cascade,
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade
);

-- -----------------------------------------------------------------------------
-- Citas y entrega al asesor
-- -----------------------------------------------------------------------------

create table app.citas (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  contacto_id       uuid not null,
  conversacion_id   uuid not null,
  rol_codigo        app.codigo_rol not null,
  inicio            timestamptz not null,
  zona_horaria      text not null,
  duracion_minutos  integer check (duracion_minutos is null or duracion_minutos > 0),
  modalidad         text not null,
  proveedor         app.proveedor_integracion not null,
  id_externo        text,
  estado            app.estado_cita not null default 'seleccion_pendiente',
  asesor_id         uuid,
  respuesta_proveedor jsonb,
  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade,
  foreign key (tenant_id, conversacion_id) references app.conversaciones (tenant_id, id) on delete cascade,
  foreign key (tenant_id, asesor_id) references app.asesores (tenant_id, id),
  check (proveedor in ('gohighlevel_calendar', 'calendly', 'google_calendar')),
  -- AC 32: una cita solo se considera confirmada con respuesta del proveedor.
  check (estado not in ('confirmada', 'reprogramada') or id_externo is not null)
);

-- AC 40: los reintentos no crean citas duplicadas.
create unique index citas_id_externo_unico
  on app.citas (tenant_id, proveedor, id_externo) where id_externo is not null;
-- Un contacto tiene a lo sumo una cita activa.
create unique index citas_una_activa_por_contacto
  on app.citas (tenant_id, contacto_id)
  where estado in ('seleccion_pendiente', 'confirmada', 'reprogramada');

create trigger citas_actualizado
  before update on app.citas
  for each row execute function app.tocar_actualizado();

create table app.entregas_asesor (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  contacto_id        uuid not null,
  cita_id            uuid,
  asesor_id          uuid not null,
  resumen            text not null,
  -- AC 42: entrega manual sin cita como excepción operativa con motivo.
  es_excepcion       boolean not null default false,
  motivo_excepcion   text,
  registrada_por     uuid,                -- auth.users.id cuando es manual
  notificado_en      timestamptz,
  creado_en          timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade,
  foreign key (tenant_id, cita_id) references app.citas (tenant_id, id),
  foreign key (tenant_id, asesor_id) references app.asesores (tenant_id, id),
  check (
    (not es_excepcion and cita_id is not null)
    or (es_excepcion and coalesce(btrim(motivo_excepcion), '') <> '')
  )
);

-- AC 40: una cita produce una sola entrega/notificación.
create unique index entregas_una_por_cita
  on app.entregas_asesor (tenant_id, cita_id) where cita_id is not null;

-- AC 35: no se entrega sin cita confirmada por el proveedor.
create or replace function app.validar_entrega_asesor()
returns trigger
language plpgsql
as $$
declare
  v_estado_cita app.estado_cita;
  v_contacto_cita uuid;
begin
  if new.cita_id is not null then
    select estado, contacto_id into v_estado_cita, v_contacto_cita
    from app.citas
    where tenant_id = new.tenant_id and id = new.cita_id;

    if v_contacto_cita is distinct from new.contacto_id then
      raise exception 'La cita % no pertenece al contacto %', new.cita_id, new.contacto_id
        using errcode = 'check_violation';
    end if;

    if v_estado_cita not in ('confirmada', 'reprogramada') then
      raise exception 'No se puede entregar al asesor: la cita % está en estado %', new.cita_id, v_estado_cita
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger entregas_validar
  before insert or update on app.entregas_asesor
  for each row execute function app.validar_entrega_asesor();

-- -----------------------------------------------------------------------------
-- Máquina de estados del contacto
-- -----------------------------------------------------------------------------

create table app.transiciones_estado (
  desde  app.estado_contacto not null,
  hacia  app.estado_contacto not null,
  primary key (desde, hacia)
);

insert into app.transiciones_estado (desde, hacia) values
  -- Calificación
  ('en_calificacion',                   'informacion_incompleta'),
  ('en_calificacion',                   'no_calificado'),
  ('en_calificacion',                   'calificado_pendiente_agendamiento'),
  ('informacion_incompleta',            'en_calificacion'),
  ('informacion_incompleta',            'no_calificado'),
  ('informacion_incompleta',            'calificado_pendiente_agendamiento'),
  ('informacion_incompleta',            'archivado'),
  ('no_calificado',                     'archivado'),
  -- Agendamiento
  ('calificado_pendiente_agendamiento', 'seleccion_pendiente_confirmacion'),
  ('calificado_pendiente_agendamiento', 'sin_disponibilidad'),
  ('calificado_pendiente_agendamiento', 'error_agendamiento'),
  ('calificado_pendiente_agendamiento', 'cita_confirmada'),   -- reserva por enlace
  ('seleccion_pendiente_confirmacion',  'cita_confirmada'),
  ('seleccion_pendiente_confirmacion',  'calificado_pendiente_agendamiento'), -- horario agotado
  ('seleccion_pendiente_confirmacion',  'error_agendamiento'),
  ('sin_disponibilidad',                'calificado_pendiente_agendamiento'),
  ('sin_disponibilidad',                'seleccion_pendiente_confirmacion'),
  ('error_agendamiento',                'calificado_pendiente_agendamiento'),
  ('error_agendamiento',                'seleccion_pendiente_confirmacion'),
  ('error_agendamiento',                'cita_confirmada'),
  -- Entrega y seguimiento
  ('cita_confirmada',                   'entregado_asesor'),
  ('cita_confirmada',                   'cita_reprogramada'),
  ('cita_confirmada',                   'cita_cancelada'),
  ('entregado_asesor',                  'cita_reprogramada'),
  ('entregado_asesor',                  'cita_cancelada'),
  ('entregado_asesor',                  'atencion_comercial_iniciada'),
  ('cita_reprogramada',                 'entregado_asesor'),
  ('cita_reprogramada',                 'cita_cancelada'),
  ('cita_reprogramada',                 'atencion_comercial_iniciada'),
  ('cita_cancelada',                    'calificado_pendiente_agendamiento'),
  -- Excepción operativa: entrega manual sin cita (AC 42)
  ('calificado_pendiente_agendamiento', 'entregado_asesor'),
  ('sin_disponibilidad',                'entregado_asesor'),
  ('error_agendamiento',                'entregado_asesor');

create table app.historial_estados (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null,
  contacto_id  uuid not null,
  desde        app.estado_contacto,
  hacia        app.estado_contacto not null,
  motivo       text,
  creado_en    timestamptz not null default now(),
  foreign key (tenant_id, contacto_id) references app.contactos (tenant_id, id) on delete cascade
);

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

create trigger contactos_validar_transicion
  before insert or update of estado on app.contactos
  for each row execute function app.validar_transicion_contacto();

create or replace function app.registrar_historial_estado()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' or new.estado is distinct from old.estado then
    insert into app.historial_estados (tenant_id, contacto_id, desde, hacia, motivo)
    values (
      new.tenant_id,
      new.id,
      case when tg_op = 'UPDATE' then old.estado end,
      new.estado,
      new.motivo_estado
    );
  end if;
  return new;
end;
$$;

create trigger contactos_historial
  after insert or update of estado on app.contactos
  for each row execute function app.registrar_historial_estado();

-- -----------------------------------------------------------------------------
-- Auditoría y fallas de integración (AC 46, AC 47)
-- -----------------------------------------------------------------------------

create table app.eventos (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references app.tenants (id) on delete cascade,
  nivel            app.nivel_evento not null default 'info',
  proveedor        app.proveedor_integracion,
  operacion        text not null,
  entidad          text,
  entidad_id       uuid,
  mensaje          text not null,
  contexto         jsonb not null default '{}'::jsonb,
  -- Clave de idempotencia de la ejecución de n8n para correlacionar reintentos.
  clave_ejecucion  text,
  resuelto         boolean not null default false,
  creado_en        timestamptz not null default now()
);

create index eventos_pendientes on app.eventos (tenant_id, creado_en desc)
  where nivel = 'error' and not resuelto;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'canales', 'roles_agente', 'plantillas', 'asesores', 'contactos',
    'conversaciones', 'mensajes', 'verificaciones_direccion',
    'evaluaciones_calificacion', 'citas', 'entregas_asesor',
    'historial_estados', 'eventos'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format(
      'create policy %I on app.%I for select to authenticated
         using (tenant_id in (select app.tenants_del_usuario()))',
      t || '_lectura_miembros', t
    );
    execute format(
      'create policy %I on app.%I for all to authenticated
         using (app.es_admin_de(tenant_id))
         with check (app.es_admin_de(tenant_id))',
      t || '_escritura_admin', t
    );
  end loop;
end;
$$;

alter table app.tenants enable row level security;
create policy tenants_lectura_miembros on app.tenants for select to authenticated
  using (id in (select app.tenants_del_usuario()));

alter table app.miembros_tenant enable row level security;
create policy miembros_lectura_propia on app.miembros_tenant for select to authenticated
  using (tenant_id in (select app.tenants_del_usuario()));

-- Las integraciones pueden revelar ids de subcuentas: solo administradores.
alter table app.integraciones enable row level security;
create policy integraciones_admin on app.integraciones for all to authenticated
  using (app.es_admin_de(tenant_id))
  with check (app.es_admin_de(tenant_id));

alter table app.transiciones_estado enable row level security;
create policy transiciones_lectura on app.transiciones_estado for select to authenticated
  using (true);

grant usage on schema app to authenticated, service_role;
grant select, insert, update, delete on all tables in schema app to authenticated, service_role;
grant usage, select on all sequences in schema app to authenticated, service_role;
grant execute on all functions in schema app to authenticated, service_role;
