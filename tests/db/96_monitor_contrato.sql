-- Pruebas del contrato del Monitor de Agentes (migración 0022).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

-- Datos: un contacto de WhatsApp con dos conversaciones (una cerrada por
-- inactividad) y otro negocio que el monitor no debe ver.
insert into app.tenants (slug, nombre) values ('otro-negocio', 'Otro negocio');
insert into app.canales (tenant_id, tipo, identificador_externo)
  select id, 'whatsapp', 'MONITOR_OTRO' from app.tenants where slug = 'otro-negocio';

create temp table mc as
select
  (select id from app.tenants where slug = 'javier-nunez') as t,
  (select id from app.canales where identificador_externo = '1371752999353628') as canal,
  (select id from app.tenants where slug = 'otro-negocio') as t2,
  (select id from app.canales where identificador_externo = 'MONITOR_OTRO') as canal2,
  gen_random_uuid() as contacto, gen_random_uuid() as conv_vieja, gen_random_uuid() as conv_nueva,
  gen_random_uuid() as contacto2, gen_random_uuid() as conv2;

insert into app.contactos (id, tenant_id, nombre, telefono, canal_origen)
  select contacto, t, 'Ana Prueba', '+573990000961', 'whatsapp' from mc;
insert into app.conversaciones (id, tenant_id, contacto_id, canal_id, abierta)
  select conv_vieja, t, contacto, canal, false from mc;
insert into app.conversaciones (id, tenant_id, contacto_id, canal_id)
  select conv_nueva, t, contacto, canal from mc;
insert into app.mensajes (tenant_id, conversacion_id, direccion, remitente, contenido, creado_en)
  select t, conv_vieja, 'entrante'::app.direccion_mensaje, 'contacto'::app.remitente_mensaje, 'Quiero vender mi apartamento', now() - interval '3 days' from mc
  union all select t, conv_vieja, 'saliente', 'agente', 'Con gusto te ayudo', now() - interval '3 days' + interval '1 minute' from mc
  union all select t, conv_nueva, 'entrante', 'contacto', 'Hola de nuevo', now() - interval '2 minutes' from mc
  union all select t, conv_nueva, 'saliente', 'asesor', 'Soy Javier, te llamo hoy', now() - interval '1 minute' from mc;

insert into app.contactos (id, tenant_id, nombre, telefono, canal_origen)
  select contacto2, t2, 'Ajeno', '+573990000962', 'whatsapp' from mc;
insert into app.conversaciones (id, tenant_id, contacto_id, canal_id)
  select conv2, t2, contacto2, canal2 from mc;
insert into app.mensajes (tenant_id, conversacion_id, direccion, remitente, contenido)
  select t2, conv2, 'entrante', 'contacto', 'Mensaje de otro negocio' from mc;

-- Lista: un solo hilo por contacto, con el último mensaje y el total.
create temp table todas as select * from public.monitor_conversaciones(null, 1000);
select pg_temp.esperar(not exists (select 1 from todas where sender_id = '573990000962'), 'no aparece el contacto de otro negocio');
create temp table lista as select * from todas where session_key = 'whatsapp:573990000961';
select pg_temp.esperar((select count(*) from lista) = 1, 'la clave es canal:teléfono sin + y hay un solo hilo por contacto');
select pg_temp.esperar((select message_count from lista) = 4, 'junta los mensajes de ambas conversaciones');
select pg_temp.esperar((select last_role from lista) = 'advisor', 'el último mensaje es del asesor');
select pg_temp.esperar((select last_message from lista) = 'Soy Javier, te llamo hoy', 'muestra el último mensaje');
select pg_temp.esperar((select from_ad from lista) = false, 'sin datos de anuncio');

-- Búsqueda por texto de un mensaje viejo, por nombre, y sin resultados.
select pg_temp.esperar(exists (select 1 from public.monitor_conversaciones('vender mi apartamento', 1000) where sender_id = '573990000961'), 'busca en mensajes viejos');
select pg_temp.esperar(exists (select 1 from public.monitor_conversaciones('ana prueba', 1000) where sender_id = '573990000961'), 'busca por nombre');
select pg_temp.esperar((select count(*) from public.monitor_conversaciones('Mensaje de otro negocio')) = 0, 'no busca en otro negocio');

-- Hilo: orden cronológico, roles del contrato y tope de mensajes.
create temp table hilo as select public.monitor_conversacion('whatsapp:573990000961') as j;
select pg_temp.esperar((select j->'contact'->>'name' from hilo) = 'Ana Prueba', 'trae el nombre del contacto');
select pg_temp.esperar((select jsonb_array_length(j->'messages') from hilo) = 4, 'trae los 4 mensajes');
select pg_temp.esperar((select j->'messages'->0->>'content' from hilo) = 'Quiero vender mi apartamento', 'el primero es el más viejo');
select pg_temp.esperar((select string_agg(e->>'role', ',' order by n) from hilo, jsonb_array_elements(j->'messages') with ordinality as x(e, n))
  = 'user,assistant,user,advisor', 'traduce remitentes a roles del contrato');
select pg_temp.esperar((select jsonb_array_length(j->'messages') from (select public.monitor_conversacion('whatsapp:573990000961', 2) as j) s) = 2,
  'respeta el límite');
select pg_temp.esperar((select (j->'messages'->1->>'content') from (select public.monitor_conversacion('whatsapp:573990000961', 2) as j) s)
  = 'Soy Javier, te llamo hoy', 'con límite trae los más recientes');
select pg_temp.esperar((select public.monitor_conversacion('whatsapp:573990000962')) = '{"contact": null, "messages": []}'::jsonb,
  'un contacto de otro negocio no devuelve nada');

-- Permisos: solo service_role.
select pg_temp.esperar(not has_function_privilege('anon', 'public.monitor_conversaciones(text, int)', 'execute'), 'anon no ejecuta la lista');
select pg_temp.esperar(not has_function_privilege('authenticated', 'public.monitor_conversacion(text, int)', 'execute'), 'authenticated no ejecuta el hilo');
select pg_temp.esperar(has_function_privilege('service_role', 'public.monitor_conversaciones(text, int)', 'execute'), 'service_role ejecuta la lista');

do $$ begin raise notice 'OK contrato del monitor'; end $$;
