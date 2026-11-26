-- Pruebas del panel de configuración (migración 0020).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

-- Fusión profunda
select pg_temp.esperar(app.fusionar_jsonb('{"a":{"x":1,"y":2},"b":1}', '{"a":{"y":3},"c":null}')
  = '{"a":{"x":1,"y":3},"b":1,"c":null}'::jsonb, 'fusionar_jsonb fusiona objetos y el segundo gana');
select pg_temp.esperar(app.fusionar_jsonb('{"a":[1,2]}', '{"a":[3]}') = '{"a":[3]}'::jsonb, 'los arreglos se reemplazan completos');

create temp table pc_t as select id as t from app.tenants where slug = 'javier-nunez';
grant select on pc_t to authenticated;
insert into app.miembros_tenant (tenant_id, user_id, rol) select t, '00000000-0000-0000-0000-0000000000a1', 'admin_operacion' from pc_t;
insert into app.miembros_tenant (tenant_id, user_id, rol) select t, '00000000-0000-0000-0000-0000000000a2', 'asesor' from pc_t;

-- Sin sesión (anónimo o n8n sin usuario) no se puede cambiar nada.
do $$ begin
  perform app.actualizar_parametros((select t from pc_t), '{"propietarios.valor_minimo_cop": 1}');
  raise exception 'Falló: aceptó un cambio sin usuario';
exception when insufficient_privilege then null;
end $$;

-- Un asesor (no admin) tampoco.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform app.actualizar_parametros((select t from pc_t), '{"propietarios.valor_minimo_cop": 1}');
  raise exception 'Falló: un asesor cambió parámetros';
exception when insufficient_privilege then null;
end $$;

-- El admin cambia valores; los iguales no se registran.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
select app.actualizar_parametros((select t from pc_t), jsonb_build_object(
  'propietarios.valor_minimo_cop', 500000000,
  'arriendo.canon_minimo_cop', 3000000,
  'propietarios.tolerancia_valor_pct', 10));
select pg_temp.esperar((select parametros #>> '{propietarios,valor_minimo_cop}' from app.tenants where id = (select t from pc_t)) = '500000000', 'guarda el valor mínimo');
select pg_temp.esperar((select parametros #>> '{arriendo,canon_minimo_cop}' from app.tenants where id = (select t from pc_t)) = '3000000', 'un parámetro nulo acepta un número');
select pg_temp.esperar((select count(*) from app.cambios_configuracion) = 2, 'registra solo los dos cambios reales');
select pg_temp.esperar((select user_id from app.cambios_configuracion where ruta = 'propietarios.valor_minimo_cop') = '00000000-0000-0000-0000-0000000000a1', 'el historial guarda quién cambió');
select pg_temp.esperar((select valor_anterior from app.cambios_configuracion where ruta = 'propietarios.valor_minimo_cop') = '450000000', 'el historial guarda el valor anterior');

-- Ruta inexistente y tipo distinto: se rechazan sin cambiar nada.
do $$ begin
  perform app.actualizar_parametros((select t from pc_t), '{"propietarios.inventado": 1}');
  raise exception 'Falló: aceptó un parámetro desconocido';
exception when invalid_parameter_value then null;
end $$;
do $$ begin
  perform app.actualizar_parametros((select t from pc_t), '{"propietarios.valor_minimo_cop": "mucho"}');
  raise exception 'Falló: aceptó un texto donde va un número';
exception when invalid_parameter_value then null;
end $$;
select pg_temp.esperar((select parametros #>> '{propietarios,valor_minimo_cop}' from app.tenants where id = (select t from pc_t)) = '500000000', 'un rechazo no deja cambios a medias');

-- Como usuario del panel (rol authenticated): no puede escribir la tabla directo
-- y solo ve el historial de su tenant.
set role authenticated;
update app.tenants set parametros = '{}' where id = (select t from pc_t);
select pg_temp.esperar((select parametros <> '{}'::jsonb from app.tenants where id = (select t from pc_t)), 'RLS impide actualizar app.tenants directamente');
select pg_temp.esperar((select count(*) from app.cambios_configuracion) = 2, 'el miembro ve el historial de su tenant');
do $$ begin
  insert into app.cambios_configuracion (tenant_id, ruta) select t, 'x' from pc_t;
  raise exception 'Falló: un usuario escribió el historial directamente';
exception when insufficient_privilege then null;
end $$;

-- Ciudades (migración 0021): el admin las ve y las administra desde el panel.
select pg_temp.esperar((select count(*) from app.ciudades_cobertura where ciudad = 'Bogotá') = 1, 'el admin ve las ciudades');
insert into app.ciudades_cobertura (tenant_id, ciudad) select t, 'Chía' from pc_t;
update app.ciudades_cobertura set activa = false where ciudad = 'Chía';
select pg_temp.esperar((select not activa from app.ciudades_cobertura where ciudad = 'Chía'), 'el admin desactiva una ciudad');
delete from app.ciudades_cobertura where ciudad = 'Chía';

-- Un asesor ve las ciudades pero RLS no le deja cambiarlas.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.esperar((select count(*) from app.ciudades_cobertura) >= 1, 'el asesor ve las ciudades');
update app.ciudades_cobertura set activa = false where ciudad = 'Bogotá';
do $$ begin
  insert into app.ciudades_cobertura (tenant_id, ciudad) select t, 'Cota' from pc_t;
  raise exception 'Falló: un asesor agregó una ciudad';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.esperar((select activa from app.ciudades_cobertura where ciudad = 'Bogotá'), 'RLS impide que un asesor desactive ciudades');
reset request.jwt.claim.sub;

-- Volver a aplicar el seed no pisa lo que se cambió en el panel.
\ir ../../supabase/seed.sql
select pg_temp.esperar((select parametros #>> '{propietarios,valor_minimo_cop}' from app.tenants where id = (select t from pc_t)) = '500000000', 'el seed conserva los valores del panel');
select pg_temp.esperar((select parametros #>> '{propietarios,valor_premium_cop}' from app.tenants where id = (select t from pc_t)) = '1000000000', 'el seed conserva los demás valores');

do $$ begin raise notice 'OK panel de configuración'; end $$;
