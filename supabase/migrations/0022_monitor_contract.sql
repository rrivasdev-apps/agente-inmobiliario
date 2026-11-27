-- Contrato de lectura del Monitor de Agentes (app de Rafael Rivas, repo agent-monitor).
--
-- El monitor no conoce las tablas de este proyecto: solo llama a
-- public.monitor_conversaciones y public.monitor_conversacion, con la forma
-- definida en agent-monitor/contract/README.md. Solo lectura y solo para
-- service_role (la llave `agent_monitor` de este proyecto).
--
-- Van en `public` porque el monitor llama al esquema por defecto de la Data API.

-- Esta base admite varios negocios; el monitor ve uno solo. Cambiar de negocio
-- (o separar uno nuevo) es cambiar esta función, no las del contrato.
create or replace function app.monitor_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select id from app.tenants where slug = 'javier-nunez'
$$;

-- Vocabulario del contrato: user (contacto), assistant (agente),
-- advisor (asesor humano), system (avisos automáticos).
create or replace function app.monitor_rol(p_remitente app.remitente_mensaje)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_remitente
    when 'contacto' then 'user'
    when 'agente'   then 'assistant'
    when 'asesor'   then 'advisor'
    else 'system'
  end
$$;

-- Todos los mensajes del negocio, con la clave de conversación del monitor.
-- La clave es por contacto y canal (no por app.conversaciones): el agente cierra
-- conversaciones por inactividad, y en el monitor deben verse como un solo hilo.
create or replace function app.monitor_mensajes()
returns table (
  canal            text,
  remitente_id     text,
  nombre           text,
  contacto_desde   timestamptz,
  mensaje_id       uuid,
  rol              text,
  contenido        text,
  creado_en        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      case
        when ca.tipo = 'whatsapp' then 'whatsapp'
        when ca.tipo in ('instagram_dm', 'instagram_comentario') then 'instagram'
        else 'messenger'
      end as canal,
      c.id as contacto_id, c.nombre, c.telefono, c.instagram_id, c.creado_en as contacto_desde,
      m.id as mensaje_id, m.remitente, m.contenido, m.creado_en
    from app.mensajes m
    join app.conversaciones v on v.tenant_id = m.tenant_id and v.id = m.conversacion_id
    join app.contactos c on c.tenant_id = v.tenant_id and c.id = v.contacto_id
    join app.canales ca on ca.tenant_id = v.tenant_id and ca.id = v.canal_id
    where m.tenant_id = app.monitor_tenant_id()
  )
  select
    canal,
    -- WhatsApp sin "+" para que el botón wa.me del monitor funcione.
    coalesce(
      case canal when 'whatsapp' then ltrim(telefono, '+') when 'instagram' then instagram_id end,
      contacto_id::text
    ),
    nombre, contacto_desde, mensaje_id, app.monitor_rol(remitente), contenido, creado_en
  from base
$$;

create or replace function public.monitor_conversaciones(busqueda text default null, limite int default 100)
returns table (
  session_key    text,
  channel        text,
  sender_id      text,
  name           text,
  last_message   text,
  last_role      text,
  last_at        timestamptz,
  message_count  bigint,
  from_ad        boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with mensajes as (
    select * from app.monitor_mensajes()
  ),
  numerados as (
    select *,
      count(*) over hilo as total,
      row_number() over (hilo order by creado_en desc, mensaje_id desc) as orden
    from mensajes
    window hilo as (partition by canal, remitente_id)
  ),
  coinciden as (
    select distinct canal, remitente_id
    from mensajes
    where coalesce(btrim(busqueda), '') = ''
       or contenido ilike '%' || btrim(busqueda) || '%'
       or nombre ilike '%' || btrim(busqueda) || '%'
       or remitente_id ilike '%' || btrim(busqueda) || '%'
  )
  select
    n.canal || ':' || n.remitente_id,
    n.canal,
    n.remitente_id,
    n.nombre,
    n.contenido,
    n.rol,
    n.creado_en,
    n.total,
    false  -- este agente no guarda el anuncio de origen
  from numerados n
  join coinciden k on k.canal = n.canal and k.remitente_id = n.remitente_id
  where n.orden = 1
  order by n.creado_en desc
  limit greatest(coalesce(limite, 100), 1)
$$;

create or replace function public.monitor_conversacion(clave text, limite int default 500)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with hilo as (
    select * from app.monitor_mensajes()
    where canal = split_part(clave, ':', 1)
      and remitente_id = substr(clave, strpos(clave, ':') + 1)
  ),
  ultimos as (
    select * from hilo
    order by creado_en desc, mensaje_id desc
    limit greatest(coalesce(limite, 500), 1)
  )
  select jsonb_build_object(
    'contact', (
      select jsonb_build_object(
        'name', nombre,
        'first_seen_at', contacto_desde,
        'ad_headline', null,
        'ad_source_url', null
      )
      from hilo order by contacto_desde limit 1
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mensaje_id,
        'role', rol,
        'content', contenido,
        'created_at', creado_en
      ) order by creado_en, mensaje_id)
      from ultimos
    ), '[]'::jsonb)
  )
$$;

-- Solo service_role. Supabase da EXECUTE a anon y authenticated por defecto en
-- `public`, así que hay que quitarlo explícitamente.
do $$
declare
  f text;
begin
  foreach f in array array[
    'app.monitor_tenant_id()',
    'app.monitor_rol(app.remitente_mensaje)',
    'app.monitor_mensajes()',
    'public.monitor_conversaciones(text, int)',
    'public.monitor_conversacion(text, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
