-- Pruebas de cierre por inactividad, retorno y nueva evaluación (migración 0006).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

create temp table rt (paso text primary key, v jsonb);
create or replace function pg_temp.entrante(p_paso text, p_id text, p_texto text)
returns void language sql as $$
  insert into rt select p_paso, app.recibir_mensaje(jsonb_build_object(
    'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
    'id_externo', p_id, 'remitente_id', '573005550201', 'nombre', 'Rafael', 'texto', p_texto));
$$;

select pg_temp.entrante('m1', 'wamid.rt1', 'Quiero vender mi casa');
create temp table rt_ids as select ((select v->'tenant'->>'id' from rt where paso = 'm1'))::uuid as t,
                                   ((select v->'conversacion'->>'id' from rt where paso = 'm1'))::uuid as c;
select pg_temp.esperar((select v->'retorno' from rt where paso = 'm1') = 'null'::jsonb, 'primera conversación: sin retorno');
select app.asignar_rol((select t from rt_ids), (select c from rt_ids), '{"intencion": "vender"}');
select app.registrar_datos((select t from rt_ids), (select c from rt_ids),
  '{"datos": {"nombre": "Rafael", "ciudad": "Barranquilla", "barrio": "Riomar", "direccion": "Cra 59 # 94-100"}}');

-- No calificado por ciudad; luego corrige el inmueble y vuelve a calificar
select app.guardar_evaluacion((select t from rt_ids), (select c from rt_ids),
  '{"evaluacion": {"resultado": "no_calificado", "accion": "archivar", "campos_faltantes": [], "codigo_motivo": "cobertura_ciudad"}}');
select pg_temp.esperar((select estado from app.contactos where telefono = '+573005550201') = 'no_calificado', 'no calificado');
insert into rt select 'recalifica', app.guardar_evaluacion((select t from rt_ids), (select c from rt_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "alta", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from rt where paso = 'recalifica') = 'calificado_pendiente_agendamiento',
  'un no calificado que corrige datos se vuelve a evaluar');

-- Dirección verificada en esta conversación
select app.registrar_verificacion((select t from rt_ids), (select c from rt_ids),
  '{"resultado": "verificada", "direccion_normalizada": "Cra. 59 #94-100, Barranquilla"}');

-- Dentro de las 48 h: misma conversación, sin retorno
select pg_temp.entrante('m2', 'wamid.rt2', 'Gracias');
select pg_temp.esperar((select (v->'conversacion'->>'id')::uuid from rt where paso = 'm2') = (select c from rt_ids), 'dentro de 48 h sigue la misma conversación');
select pg_temp.esperar((select v->'retorno' from rt where paso = 'm2') = 'null'::jsonb, 'sin retorno dentro de 48 h');

-- Pasan 3 días sin mensajes
update app.mensajes set creado_en = creado_en - interval '3 days' where conversacion_id = (select c from rt_ids);
update app.conversaciones set creado_en = creado_en - interval '3 days' where id = (select c from rt_ids);

select pg_temp.entrante('m3', 'wamid.rt3', 'Hola');
select pg_temp.esperar((select (v->'conversacion'->>'id')::uuid from rt where paso = 'm3') <> (select c from rt_ids), 'después de 48 h abre otra conversación');
select pg_temp.esperar((select not abierta and motivo_cierre = 'inactividad' and cerrada_en is not null
                        from app.conversaciones where id = (select c from rt_ids)), 'la anterior queda cerrada por inactividad');
select pg_temp.esperar((select v->'conversacion'->>'rol_codigo' from rt where paso = 'm3') = 'lucia', 'la nueva conserva el rol');
select pg_temp.esperar((select v->'rol'->>'codigo' from rt where paso = 'm3') = 'lucia', 'el contexto trae el rol');
select pg_temp.esperar((select (v->'retorno'->>'horas_sin_contacto')::int from rt where paso = 'm3') >= 72, 'retorno con horas sin contacto');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from rt where paso = 'm3') = 'verificada', 'la verificación se conserva por contacto');
select pg_temp.esperar(not (select (v->>'verificacion_pendiente')::boolean from rt where paso = 'm3'), 'no vuelve a geocodificar');
select pg_temp.esperar((select count(*) from app.conversaciones where contacto_id = (select contacto_id from app.conversaciones where id = (select c from rt_ids)) and abierta) = 1,
  'una sola conversación abierta');

-- El segundo mensaje de la conversación nueva ya no es retorno
select pg_temp.entrante('m4', 'wamid.rt4', 'Quiero agendar');
select pg_temp.esperar((select v->'retorno' from rt where paso = 'm4') = 'null'::jsonb, 'retorno solo en el primer mensaje');

-- Cierre programado
update app.mensajes set creado_en = creado_en - interval '3 days'
where conversacion_id = (select (v->'conversacion'->>'id')::uuid from rt where paso = 'm3');
select pg_temp.esperar(app.cerrar_conversaciones_inactivas() >= 1, 'el cierre programado cierra las inactivas');
select pg_temp.esperar(not (select abierta from app.conversaciones where id = (select (v->'conversacion'->>'id')::uuid from rt where paso = 'm3')),
  'conversación cerrada por el cierre programado');

-- El umbral es configurable por tenant
update app.tenants set parametros = jsonb_set(parametros, '{conversacion}', '{"cierre_inactividad_horas": 200}') where id = (select t from rt_ids);
select pg_temp.esperar(not app.conversacion_inactiva((select t from rt_ids), (select c from rt_ids)), 'umbral configurable');
update app.tenants set parametros = jsonb_set(parametros, '{conversacion}', '{"cierre_inactividad_horas": 48}') where id = (select t from rt_ids);

do $$ begin raise notice 'OK cierre por inactividad, retorno y nueva evaluación'; end $$;
