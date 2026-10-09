-- Pruebas de calificación mixta, parámetros y reporte (migraciones 0004 y 0005).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

-- Seed idempotente: aplicado dos veces sin duplicar
select pg_temp.esperar((select count(*) from app.tenants where slug = 'javier-nunez') = 1, 'un tenant');
select pg_temp.esperar((select count(*) from app.roles_agente r join app.tenants t on t.id = r.tenant_id where t.slug = 'javier-nunez') = 2, 'dos roles');
select pg_temp.esperar((select count(*) from app.plantillas p join app.tenants t on t.id = p.tenant_id where t.slug = 'javier-nunez' and p.clave = 'inicio') = 2, 'plantillas sin duplicar');
select pg_temp.esperar((select nombre from app.tenants where slug = 'javier-nunez') = 'JNdelT Real Estate', 'marca');
select pg_temp.esperar((select parametros->'prioridad'->>'alta_hasta_meses' from app.tenants where slug = 'javier-nunez') = '3', 'parámetros del tenant');

-- Contacto que cumple criterios pero sin urgencia -> nutricion
create temp table pr (paso text primary key, v jsonb);
insert into pr select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.pr1', 'remitente_id', '573005550101', 'texto', 'Quiero arrendar mi apartamento'));
create temp table pr_ids as select ((select v->'tenant'->>'id' from pr where paso = 'in'))::uuid as t,
                                   ((select v->'conversacion'->>'id' from pr where paso = 'in'))::uuid as c;
select pg_temp.esperar((select v->'tenant'->'parametros'->'cobertura'->'ciudades' from pr where paso = 'in') = '["Bogotá"]'::jsonb, 'parámetros en el contexto');
select app.asignar_rol((select t from pr_ids), (select c from pr_ids), '{"intencion": "vender"}');
select app.registrar_datos((select t from pr_ids), (select c from pr_ids),
  '{"datos": {"nombre": "Marta", "operacion": "arriendo", "plazo_meses": 12}}');

insert into pr select 'baja', app.guardar_evaluacion((select t from pr_ids), (select c from pr_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "baja", "accion": "nutrir", "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from pr where paso = 'baja') = 'nutricion', 'prioridad baja -> nutricion');
select pg_temp.esperar((select prioridad from app.evaluaciones_calificacion where conversacion_id = (select c from pr_ids) order by creado_en desc limit 1) = 'baja', 'prioridad auditada');

-- Vuelve con urgencia: pasa a pendiente de agendar
insert into pr select 'alta', app.guardar_evaluacion((select t from pr_ids), (select c from pr_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "alta", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from pr where paso = 'alta') = 'calificado_pendiente_agendamiento', 'nutricion -> agendar');

-- Otro contacto no calificado, con motivo
insert into pr select 'in2', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.pr2', 'remitente_id', '573005550102', 'texto', 'Busco casa en Cali'));
select app.asignar_rol(((select v->'tenant'->>'id' from pr where paso = 'in2'))::uuid, ((select v->'conversacion'->>'id' from pr where paso = 'in2'))::uuid, '{"intencion": "comprar"}');
select app.guardar_evaluacion(((select v->'tenant'->>'id' from pr where paso = 'in2'))::uuid, ((select v->'conversacion'->>'id' from pr where paso = 'in2'))::uuid,
  '{"evaluacion": {"resultado": "no_calificado", "accion": "archivar", "campos_faltantes": [], "codigo_motivo": "cobertura_ciudad", "motivo": "Busca fuera de la zona de cobertura"}}');

-- Tercero: prioridad baja que se queda en nutrición
insert into pr select 'in3', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.pr3', 'remitente_id', '573005550103', 'texto', 'Solo estoy mirando'));
select app.asignar_rol(((select v->'tenant'->>'id' from pr where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from pr where paso = 'in3'))::uuid, '{"intencion": "comprar"}');
select app.registrar_datos(((select v->'tenant'->>'id' from pr where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from pr where paso = 'in3'))::uuid,
  '{"datos": {"nombre": "Pablo", "horizonte_compra_meses": 12}}');
select app.guardar_evaluacion(((select v->'tenant'->>'id' from pr where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from pr where paso = 'in3'))::uuid,
  '{"evaluacion": {"resultado": "calificado", "prioridad": "baja", "accion": "nutrir", "campos_faltantes": []}}');

-- Reporte
insert into pr select 'rep', app.reporte_no_calificados((select t from pr_ids), now() - interval '1 day');
select pg_temp.esperar((select v->'tenant'->>'nombre' from pr where paso = 'rep') = 'JNdelT Real Estate', 'tenant en el reporte');
select pg_temp.esperar(exists (
  select 1 from pr, jsonb_array_elements(v->'no_calificados') f
  where paso = 'rep' and f->>'telefono' = '+573005550102' and f->>'motivo' = 'Busca fuera de la zona de cobertura'), 'no calificado con motivo');
select pg_temp.esperar(exists (
  select 1 from pr, jsonb_array_elements(v->'prioridad_baja') f
  where paso = 'rep' and f->>'nombre' = 'Pablo' and f->>'plazo_meses' = '12'), 'prioridad baja con plazo');
-- Marta pasó por nutricion y luego a agendar: aparece con su estado actual
select pg_temp.esperar(exists (
  select 1 from pr, jsonb_array_elements(v->'prioridad_baja') f
  where paso = 'rep' and f->>'nombre' = 'Marta' and f->>'estado_actual' = 'calificado_pendiente_agendamiento'), 'muestra el estado actual');

select pg_temp.esperar((select count(*) from app.reportes_no_calificados()) >= 1, 'reporte por tenant habilitado');
select pg_temp.esperar((select r->'destinatarios' from app.reportes_no_calificados() r where r->'tenant'->>'nombre' = 'JNdelT Real Estate') = '[]'::jsonb, 'destinatarios desde parámetros');

set role authenticated;
create or replace function pg_temp.debe_fallar(p_sql text, p_patron text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_patron || '%' then raise exception 'Error inesperado: %', sqlerrm; end if;
    return;
  end;
  raise exception 'Se esperaba un error para: %', p_sql;
end;
$$;
select pg_temp.debe_fallar($q$select app.reportes_no_calificados()$q$, 'permission denied');
reset role;

do $$ begin raise notice 'OK seed idempotente, nutrición y reporte de no calificados'; end $$;
