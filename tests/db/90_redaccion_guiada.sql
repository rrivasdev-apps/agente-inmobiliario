-- Pruebas de redacción guiada, barrios al calificar y prioridad B (migración 0017).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

create temp table rg (paso text primary key, v jsonb);
insert into rg select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.rg1', 'remitente_id', '573005550901', 'texto', 'Quiero vender mi apartamento'));
create temp table rg_ids as select ((select v->'tenant'->>'id' from rg where paso = 'in'))::uuid as t,
                                   ((select v->'conversacion'->>'id' from rg where paso = 'in'))::uuid as c;
select app.asignar_rol((select t from rg_ids), (select c from rg_ids), '{"intencion": "vender"}');

-- Plantillas literales: solo las que requieren aprobación de Meta
insert into rg select 'ctx', app.contexto_conversacion((select t from rg_ids), (select c from rg_ids));
select pg_temp.esperar((select v->'plantillas_literales' from rg where paso = 'ctx') = '["pendiente_agenda"]'::jsonb, 'plantillas literales = las de Meta');
select pg_temp.esperar((select v->'barrios_cobertura' from rg where paso = 'ctx') is null, 'sin barrio no se cargan los barrios');

-- Un mensaje redactado con otras palabras se reconoce por la clave de su plantilla
select app.registrar_respuesta((select t from rg_ids), (select c from rg_ids),
  '{"texto": "Hola, gracias por escribirnos. Soy Lucía, la asistente virtual de Javier.", "plantilla": "inicio", "enviado": true, "id_externo": "wamid.rg-out1"}');
insert into rg select 'hist', app.contexto_conversacion((select t from rg_ids), (select c from rg_ids));
select pg_temp.esperar((
  select m->>'plantilla' from rg, jsonb_array_elements(v->'historial') m
  where paso = 'hist' and m->>'direccion' = 'saliente') = 'inicio', 'historial con la clave de la plantilla');
select pg_temp.esperar((
  select m->>'plantilla' from rg, jsonb_array_elements(v->'historial') m
  where paso = 'hist' and m->>'direccion' = 'entrante') is null, 'mensaje entrante sin plantilla');

-- Con ciudad y barrio, Lucía recibe los barrios activos para calificar
select app.registrar_datos((select t from rg_ids), (select c from rg_ids),
  '{"datos": {"nombre": "Marta Ruiz", "ciudad": "Bogotá", "barrio": "El Nogal", "operacion": "venta", "plazo_meses": 12}}');
insert into rg select 'barrios', app.contexto_conversacion((select t from rg_ids), (select c from rg_ids));
select pg_temp.esperar(jsonb_array_length((select v->'barrios_cobertura' from rg where paso = 'barrios')) > 100, 'barrios activos en el contexto');
select pg_temp.esperar(exists (
  select 1 from rg, jsonb_array_elements(v->'barrios_cobertura') b
  where paso = 'barrios' and b->>'barrio' = 'El Nogal' and (b->>'atiende')::boolean), 'El Nogal se atiende');

-- Prioridad B: calificado de prioridad baja que se agenda a futuro, no se nutre
insert into rg select 'b', app.guardar_evaluacion((select t from rg_ids), (select c from rg_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "baja", "accion": "ofrecer_agenda", "agendar_desde_dias": 14, "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from rg where paso = 'b') = 'calificado_pendiente_agendamiento', 'prioridad B -> pendiente de agendar');
select pg_temp.esperar((
  select criterios->>'agendar_desde_dias' from app.evaluaciones_calificacion
  where conversacion_id = (select c from rg_ids) order by creado_en desc limit 1) = '14', 'días de la prioridad B auditados');

-- Sin accion (o con nutrir), la prioridad baja se sigue nutriendo (0005)
insert into rg select 'in2', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.rg2', 'remitente_id', '573005550902', 'texto', 'Busco apartamento'));
select app.asignar_rol(((select v->'tenant'->>'id' from rg where paso = 'in2'))::uuid, ((select v->'conversacion'->>'id' from rg where paso = 'in2'))::uuid, '{"intencion": "comprar"}');
insert into rg select 'n', app.guardar_evaluacion(((select v->'tenant'->>'id' from rg where paso = 'in2'))::uuid, ((select v->'conversacion'->>'id' from rg where paso = 'in2'))::uuid,
  '{"evaluacion": {"resultado": "calificado", "prioridad": "baja", "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from rg where paso = 'n') = 'nutricion', 'prioridad baja sin accion -> nutricion');
select pg_temp.esperar((select v->'barrios_cobertura' from rg where paso = 'n') is null, 'Sonia no carga barrios');

do $$ begin raise notice 'OK redacción guiada, barrios al calificar y prioridad B'; end $$;
