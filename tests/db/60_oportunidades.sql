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

-- Cambio de asistente: quien hablaba con Lucía quiere comprar (migración 0008)
insert into op select 'compra', app.registrar_datos_y_seleccion((select t from op_ids), (select c from op_ids),
  '{"datos": {"presupuesto_cop": 500000000}, "cambio_intencion": "comprar"}');
select pg_temp.esperar((select v->'rol'->>'codigo' from op where paso = 'compra') = 'sonia', 'pasa con Sonia');
select pg_temp.esperar((select v->'conversacion'->>'rol_codigo' from op where paso = 'compra') = 'sonia', 'la conversación cambia de rol');
select pg_temp.esperar((select v->'oportunidad'->>'rol_anterior' from op where paso = 'compra') = 'lucia', 'informa la asistente anterior');
select pg_temp.esperar((select v->'contacto'->>'estado' from op where paso = 'compra') = 'en_calificacion', 'empieza un caso nuevo');
select pg_temp.esperar((select v->'contacto'->'datos'->>'presupuesto_cop' from op where paso = 'compra') = '500000000', 'los datos del turno van al caso de Sonia');
select pg_temp.esperar((select v->'contacto'->'datos'->>'direccion' from op where paso = 'compra') is null, 'no arrastra la dirección de la venta');
select pg_temp.esperar((select count(*) from app.oportunidades where contacto_id = (select k from op_ids)) = 3, 'tres casos: dos ventas y una compra');
-- El mismo rol no cambia nada
select pg_temp.esperar(not app.cambiar_rol((select t from op_ids), (select c from op_ids), 'sonia'), 'mismo rol: sin cambios');

-- Reporte con la autorización de referencia
select app.registrar_datos((select t from op_ids), (select c from op_ids), '{"datos": {"ciudad": "Cali"}}');
update app.contactos set datos = datos || '{"autoriza_referencia": true}' where id = (select k from op_ids);
select app.guardar_evaluacion((select t from op_ids), (select c from op_ids),
  '{"evaluacion": {"resultado": "no_calificado", "accion": "archivar", "campos_faltantes": [], "codigo_motivo": "cobertura_ciudad"}}');
select pg_temp.esperar(exists (
  select 1 from jsonb_array_elements(app.reporte_no_calificados((select t from op_ids), now() - interval '1 day')->'no_calificados') f
  where f->'autoriza_referencia' = 'true'::jsonb), 'el reporte muestra la autorización de referencia');

do $$ begin raise notice 'OK cambio de asistente y referencia en el reporte'; end $$;

-- Segunda propiedad del mismo dueño con su propia cita (migración 0010)
create temp table op2 (paso text primary key, v jsonb);
insert into op2 select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.op2-1', 'remitente_id', '573005550302', 'nombre', 'Laura', 'texto', 'Vendo apartamento'));
create temp table op2_ids as select ((select v->'tenant'->>'id' from op2))::uuid as t, ((select v->'conversacion'->>'id' from op2))::uuid as c,
                                    ((select v->'contacto'->>'id' from op2))::uuid as k;
select app.asignar_rol((select t from op2_ids), (select c from op2_ids), '{"intencion": "vender"}');
select app.registrar_datos((select t from op2_ids), (select c from op2_ids), '{"datos": {"ciudad": "Bogotá", "direccion": "Cl 1 # 2-3"}}');
select app.guardar_evaluacion((select t from op2_ids), (select c from op2_ids),
  '{"evaluacion": {"resultado": "calificado", "prioridad": "alta", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor, id_externo, estado)
select t, k, c, 'lucia', now() + interval '2 days', 'America/Bogota', 'llamada', 'gohighlevel_calendar', 'ghl-op2-1', 'confirmada' from op2_ids;
select app.registrar_datos_y_seleccion((select t from op2_ids), (select c from op2_ids), '{"datos": {"ciudad": "Bogotá", "direccion": "Cl 9 # 8-7"}, "nueva_propiedad": true}');
insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor, id_externo, estado)
select t, k, c, 'lucia', now() + interval '2 days', 'America/Bogota', 'llamada', 'gohighlevel_calendar', 'ghl-op2-2', 'confirmada' from op2_ids;
select pg_temp.esperar((select count(*) from app.citas where contacto_id = (select k from op2_ids) and estado = 'confirmada') = 2,
  'el mismo dueño tiene una cita activa por cada propiedad');
do $$ begin
  insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor, id_externo, estado)
  select t, k, c, 'lucia', now() + interval '3 days', 'America/Bogota', 'llamada', 'gohighlevel_calendar', 'ghl-op2-3', 'confirmada' from op2_ids;
  raise exception 'Falló: aceptó dos citas activas para la misma propiedad';
exception when unique_violation then null;
end $$;

do $$ begin raise notice 'OK una cita activa por propiedad'; end $$;

-- Conciliación: el contexto informa las citas ya registradas del contacto (migración 0011)
select pg_temp.esperar((select app.contexto_conversacion((select t from op2_ids), (select c from op2_ids))->'citas_externas') @> '["ghl-op2-1", "ghl-op2-2"]'::jsonb,
  'citas externas de todas las oportunidades en el contexto');
do $$ begin raise notice 'OK citas externas en el contexto'; end $$;

-- Otra propiedad mientras el caso actual se califica: no abre casos en cadena (migración 0012)
create temp table op3_n as select count(*) n from app.oportunidades where contacto_id = (select k from op2_ids);
select app.guardar_evaluacion((select t from op2_ids), (select c from op2_ids),
  '{"evaluacion": {"resultado": "informacion_incompleta", "accion": "solicitar_datos", "campos_faltantes": ["barrio"]}}');
select app.registrar_datos_y_seleccion((select t from op2_ids), (select c from op2_ids), '{"datos": {"plazo_meses": 1}, "nueva_propiedad": true}');
select app.registrar_datos_y_seleccion((select t from op2_ids), (select c from op2_ids), '{"datos": {"barrio": "Chicó"}, "nueva_propiedad": true}');
select pg_temp.esperar((select count(*) from app.oportunidades where contacto_id = (select k from op2_ids)) = (select n from op3_n),
  'mientras se califica, "otra propiedad" no abre casos nuevos');
select pg_temp.esperar((select datos->>'barrio' = 'Chicó' and datos->>'plazo_meses' = '1' from app.contactos where id = (select k from op2_ids)),
  'los datos se conservan y se completan');
-- El cambio de asistente sí abre un caso aunque se esté calificando
select pg_temp.esperar(app.cambiar_rol((select t from op2_ids), (select c from op2_ids), 'sonia'), 'cambio de asistente');
select pg_temp.esperar((select count(*) from app.oportunidades where contacto_id = (select k from op2_ids)) = (select n + 1 from op3_n),
  'el cambio de asistente abre un caso nuevo');
select pg_temp.esperar((select v from (select app.contexto_conversacion((select t from op2_ids), (select c from op2_ids)) v) x)->'historial'->0->>'creado_en' is not null,
  'historial con la hora de cada mensaje');
do $$ begin raise notice 'OK otra propiedad solo con el caso decidido'; end $$;

-- Dirección imprecisa sin bucles (migración 0013)
create temp table dr (paso text primary key, v jsonb);
insert into dr select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', '1371752999353628',
  'id_externo', 'wamid.dr1', 'remitente_id', '573005550501', 'nombre', 'Diana', 'texto', 'Vendo apartamento'));
create temp table dr_ids as select ((select v->'tenant'->>'id' from dr))::uuid as t, ((select v->'conversacion'->>'id' from dr))::uuid as c;
select app.asignar_rol((select t from dr_ids), (select c from dr_ids), '{"intencion": "vender"}');
select app.registrar_datos((select t from dr_ids), (select c from dr_ids), '{"datos": {"ciudad": "Bogotá", "barrio": "San Patricio", "direccion": "Cra 15 # 4 Bis-46"}}');
insert into dr select 'v1', app.registrar_verificacion((select t from dr_ids), (select c from dr_ids), '{"resultado": "ambigua", "direccion_normalizada": "Cra 15 #4BIS-46, Bogotá"}');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from dr where paso = 'v1') = 'ambigua', 'primer intento impreciso');
-- Habla de otra cosa: no se vuelve a consultar
insert into dr select 'otra', app.registrar_datos_y_seleccion((select t from dr_ids), (select c from dr_ids), '{"datos": {}}');
select pg_temp.esperar(not (select (v->>'verificacion_pendiente')::boolean from dr where paso = 'otra'), 'sin dirección nueva no reconsulta');
-- Vuelve a dar la misma dirección: se verifica otra vez
insert into dr select 'repite', app.registrar_datos_y_seleccion((select t from dr_ids), (select c from dr_ids), '{"datos": {"direccion": "Cra 15 # 4 Bis-46"}}');
select pg_temp.esperar((select (v->>'verificacion_pendiente')::boolean from dr where paso = 'repite'), 'la dirección repetida se verifica otra vez');
insert into dr select 'v2', app.registrar_verificacion((select t from dr_ids), (select c from dr_ids), '{"resultado": "ambigua"}');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from dr where paso = 'v2') = 'no_verificada', 'segundo intento impreciso: no_verificada (D19)');
do $$ begin raise notice 'OK dirección imprecisa sin bucles'; end $$;

-- Preferencia de horario (migración 0015)
insert into dr select 'pref', app.registrar_datos_y_seleccion((select t from dr_ids), (select c from dr_ids),
  '{"datos": {}, "preferencia_horario": {"fecha": "2030-10-23", "desde": null, "hasta": null}}');
select pg_temp.esperar((select v->'preferencia_horario'->>'fecha' from dr where paso = 'pref') = '2030-10-23', 'devuelve la preferencia al flujo');
insert into dr select 'oferta', app.registrar_oferta((select t from dr_ids), (select c from dr_ids),
  '{"ofrecidos": ["2030-10-23T09:00:00-05:00"], "texto": "1. Miércoles", "motivo": "preferencia", "dia": "miércoles 23 de octubre"}');
select pg_temp.esperar((select v->'resultado_agenda'->>'dia' from dr where paso = 'oferta') = 'miércoles 23 de octubre', 'la oferta informa el día pedido');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from dr where paso = 'oferta') = 'preferencia', 'tipo preferencia');
do $$ begin raise notice 'OK preferencia de horario'; end $$;
