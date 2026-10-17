-- Pruebas de las tablas de configuración: ciudades atendidas y usuarios (migración 0009).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

create temp table cf (paso text primary key, v jsonb);
create temp table cf_t as select id as t from app.tenants where slug = 'javier-nunez';

select pg_temp.esperar((select count(*) from app.ciudades_cobertura where tenant_id = (select t from cf_t) and ciudad = 'Bogotá' and activa) = 1,
  'el seed siembra las ciudades del parámetro una sola vez');

insert into cf select 'm1', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.cf1', 'remitente_id', '573005550401', 'texto', 'Hola'));
select pg_temp.esperar((select v->'tenant'->'parametros'->'cobertura'->'ciudades' from cf where paso = 'm1') = '["Bogotá"]'::jsonb, 'contexto con las ciudades de la tabla');

-- Agregar Chía y desactivar Bogotá
insert into app.ciudades_cobertura (tenant_id, ciudad) select t, 'Chía' from cf_t;
update app.ciudades_cobertura set activa = false where tenant_id = (select t from cf_t) and ciudad = 'Bogotá';
insert into cf select 'm2', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.cf2', 'remitente_id', '573005550401', 'texto', 'Sigo aquí'));
select pg_temp.esperar((select v->'tenant'->'parametros'->'cobertura'->'ciudades' from cf where paso = 'm2') = '["Chía"]'::jsonb, 'solo las ciudades activas');
select pg_temp.esperar((select v->'tenant'->'parametros'->'cobertura'->'tipos_inmueble' from cf where paso = 'm2') is not null, 'conserva el resto de la cobertura');
update app.ciudades_cobertura set activa = true where tenant_id = (select t from cf_t) and ciudad = 'Bogotá';
delete from app.ciudades_cobertura where tenant_id = (select t from cf_t) and ciudad = 'Chía';

-- Usuarios que reciben el reporte
insert into app.usuarios (tenant_id, nombre, email, cargo, recibe_reporte) select t, 'Javier Núñez', 'javier@ejemplo.co', 'Director', true from cf_t;
insert into app.usuarios (tenant_id, nombre, email, recibe_reporte) select t, 'Asistente', 'asistente@ejemplo.co', false from cf_t;
insert into app.usuarios (tenant_id, nombre, email, recibe_reporte, activo) select t, 'Inactivo', 'inactivo@ejemplo.co', true, false from cf_t;
select pg_temp.esperar((select r->'destinatarios' from app.reportes_no_calificados() r limit 1) = '["javier@ejemplo.co"]'::jsonb,
  'el reporte va a los usuarios activos con recibe_reporte');
do $$ begin
  insert into app.usuarios (tenant_id, nombre, email) select id, 'Malo', 'sin-arroba' from app.tenants limit 1;
  raise exception 'Falló: aceptó un correo inválido';
exception when check_violation then null;
end $$;
delete from app.usuarios;

do $$ begin raise notice 'OK tablas de ciudades atendidas y usuarios del reporte'; end $$;

-- Horarios ocupados en el contexto (migración 0014)
select pg_temp.esperar((select app.contexto_conversacion(tenant_id, id) ? 'horarios_ocupados' from app.conversaciones limit 1), 'contexto con horarios ocupados');
do $$ begin raise notice 'OK horarios ocupados'; end $$;
