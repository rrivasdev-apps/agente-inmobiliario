-- Pruebas de oportunidades: otra propiedad como caso aparte o en la misma reunión (migración 0007).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

create temp table op (paso text primary key, v jsonb);
insert into op select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.op1', 'remitente_id', '573005550301', 'nombre', 'Rafael', 'texto', 'Quiero vender mi apartamento'));
create temp table op_ids as select ((select v->'tenant'->>'id' from op where paso = 'in'))::uuid as t,
                                   ((select v->'conversacion'->>'id' from op where paso = 'in'))::uuid as c,
                                   ((select v->'contacto'->>'id' from op where paso = 'in'))::uuid as k;

select pg_temp.esperar((select oportunidad_id is not null from app.contactos where id = (select k from op_ids)), 'un contacto nuevo nace con su oportunidad');
select pg_temp.esperar((select v->'oportunidad'->>'anteriores' from op where paso = 'in') = '0', 'contexto con la oportunidad actual');

-- "Otra propiedad" sin datos todavía: no hay nada que separar
select app.asignar_rol((select t from op_ids), (select c from op_ids), '{"intencion": "vender"}');
select app.registrar_datos_y_seleccion((select t from op_ids), (select c from op_ids), '{"datos": {"nombre": "Rafael"}, "nueva_propiedad": true}');
select pg_temp.esperar((select count(*) from app.oportunidades where contacto_id = (select k from op_ids)) = 1, 'sin propiedad registrada no se abre otro caso');

-- Primera propiedad: califica y agenda
select app.registrar_datos((select t from op_ids), (select c from op_ids),
  '{"datos": {"ciudad": "Bogotá", "barrio": "San Patricio", "direccion": "Cra 17A # 106-50", "tipo_inmueble": "apartamento"}}');
select app.guardar_evaluacion((select t from op_ids), (select c from op_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "alta", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor, id_externo, estado)
select t, k, c, 'lucia', now() + interval '3 days', 'America/Bogota', 'llamada', 'gohighlevel_calendar', 'ghl-cita-1', 'confirmada' from op_ids;
select app.transicionar_si_permitido((select t from op_ids), (select k from op_ids), 'cita_confirmada');
create temp table op_primera as select oportunidad_id as o from app.contactos where id = (select k from op_ids);
select pg_temp.esperar((select oportunidad_id from app.citas where id_externo = 'ghl-cita-1') = (select o from op_primera), 'la cita queda en su oportunidad');

-- Otra propiedad, caso aparte
insert into op select 'otra', app.registrar_datos_y_seleccion((select t from op_ids), (select c from op_ids),
  '{"datos": {"ciudad": "Bogotá", "direccion": "Cra 15A # 106-50"}, "nueva_propiedad": true}');
select pg_temp.esperar((select v->'contacto'->>'estado' from op where paso = 'otra') = 'en_calificacion', 'el contacto vuelve a calificación');
select pg_temp.esperar((select v->'contacto'->'datos' from op where paso = 'otra')
  = jsonb_build_object('nombre', 'Rafael', 'telefono', '+573005550301', 'ciudad', 'Bogotá', 'direccion', 'Cra 15A # 106-50'),
  'conserva los datos de la persona y toma solo los de la nueva propiedad');
select pg_temp.esperar((select v->'cita' from op where paso = 'otra') = 'null'::jsonb, 'la cita de la primera propiedad no es de este caso');
select pg_temp.esperar((select v->'oportunidad'->>'anteriores' from op where paso = 'otra') = '1', 'una oportunidad anterior');
select pg_temp.esperar((select estado = 'cita_confirmada' and datos->>'direccion' = 'Cra 17A # 106-50' and cerrada_en is not null
                        from app.oportunidades where id = (select o from op_primera)), 'la primera queda guardada con su estado y datos');
select pg_temp.esperar(exists (select 1 from app.historial_estados where contacto_id = (select k from op_ids)
                               and desde = 'cita_confirmada' and hacia = 'en_calificacion' and motivo = 'nueva_oportunidad'), 'historial del cambio de caso');

-- Las evaluaciones nuevas son de la nueva oportunidad
select app.guardar_evaluacion((select t from op_ids), (select c from op_ids),
  '{"evaluacion": {"resultado": "informacion_incompleta", "accion": "solicitar_datos", "campos_faltantes": ["barrio"]}}');
select pg_temp.esperar((select oportunidad_id from app.evaluaciones_calificacion where contacto_id = (select k from op_ids) order by creado_en desc limit 1)
  <> (select o from op_primera), 'evaluación asociada a la nueva oportunidad');

-- Pide revisarla en la reunión ya agendada
insert into op select 'misma', app.registrar_datos_y_seleccion((select t from op_ids), (select c from op_ids),
  '{"datos": {"barrio": "Santa Bárbara"}, "misma_cita": true}');
select pg_temp.esperar((select v->'oportunidad'->'cita_compartida'->>'estado' from op where paso = 'misma') = 'confirmada', 'comparte la reunión agendada');
insert into op select 'califica', app.guardar_evaluacion((select t from op_ids), (select c from op_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "baja", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from op where paso = 'califica') = 'cita_confirmada', 'al calificar queda con la reunión compartida');

-- Nota para el asesor
insert into op select 'nota', app.registrar_nota_asesor((select t from op_ids), (select c from op_ids),
  '{"ok": true, "evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda"}}');
select pg_temp.esperar((select v->'oportunidad'->>'nota_asesor_en' from op where paso = 'nota') is not null, 'nota registrada una vez');
select pg_temp.esperar((select v->'evaluacion'->>'accion' from op where paso = 'nota') = 'ofrecer_agenda', 'la evaluación sigue en el contexto');
select app.registrar_nota_asesor((select t from op_ids), (select c from op_ids), '{"ok": false, "error": {"motivo": "credencial_invalida"}}');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'nota_asesor' and nivel = 'error'), 'falla de la nota registrada');

do $$ begin raise notice 'OK oportunidades: caso aparte, misma reunión y nota para el asesor'; end $$;
