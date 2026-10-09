-- Pruebas del agendamiento con GoHighLevel (migración 0003).
\set ON_ERROR_STOP on

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

-- Contacto calificado (Sonia) por WhatsApp -----------------------------------------
create temp table ag (paso text primary key, v jsonb);

insert into ag select 'in', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID',
  'id_externo', 'wamid.ag1', 'remitente_id', '573005550001', 'texto', 'Busco apartamento'));
create temp table ag_ids as select ((select v->'tenant'->>'id' from ag where paso = 'in'))::uuid as t,
                                   ((select v->'conversacion'->>'id' from ag where paso = 'in'))::uuid as c;
select app.asignar_rol((select t from ag_ids), (select c from ag_ids), '{"intencion": "comprar"}');

insert into ag select 'ctx', app.contexto_conversacion((select t from ag_ids), (select c from ag_ids));
select pg_temp.esperar((select v->'rol'->>'etiqueta_crm' from ag where paso = 'ctx') = 'agente-sonia', 'etiqueta CRM en el contexto');
select pg_temp.esperar((select v->'contacto'->>'canal_origen' from ag where paso = 'ctx') = 'whatsapp', 'canal de origen en el contexto');
select pg_temp.esperar((select v->'conversacion'->'agenda' from ag where paso = 'ctx') = '{}'::jsonb, 'agenda vacía');
select pg_temp.esperar((select v->'cita' from ag where paso = 'ctx') = 'null'::jsonb, 'sin cita');

insert into ag select 'sel', app.registrar_datos_y_seleccion((select t from ag_ids), (select c from ag_ids),
  '{"datos": {"nombre": "Lina"}, "seleccion": {"horario": 2, "modalidad": "videollamada"}}');
select pg_temp.esperar((select v->'seleccion'->>'horario' from ag where paso = 'sel') = '2', 'devuelve la selección');
select pg_temp.esperar((select v->'contacto'->'datos'->>'nombre' from ag where paso = 'sel') = 'Lina', 'registra los datos');

select app.guardar_evaluacion((select t from ag_ids), (select c from ag_ids),
  '{"evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda", "campos_faltantes": []}}');

-- Falla de GoHighLevel: error_agendamiento, luego la oferta lo recupera
insert into ag select 'err', app.registrar_oferta((select t from ag_ids), (select c from ag_ids),
  '{"error": {"motivo": "credencial_invalida"}}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'err') = 'error', 'oferta con error');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'err') = 'error_agendamiento', 'estado error_agendamiento');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'consultar_disponibilidad' and nivel = 'error'), 'evento de error');

-- La evaluación no saca al contacto del agendamiento
select app.guardar_evaluacion((select t from ag_ids), (select c from ag_ids),
  '{"evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
select pg_temp.esperar((select estado from app.contactos where telefono = '+573005550001') = 'error_agendamiento', 'evaluación no cambia el estado de agendamiento');

insert into ag select 'of', app.registrar_oferta((select t from ag_ids), (select c from ag_ids),
  '{"ghl_contact_id": "ghl_ag_1", "motivo": "ofrecidos", "texto": "1. Lunes 9 am\n2. Martes 3 pm",
    "ofrecidos": ["2026-10-12T09:00:00-05:00", "2026-10-13T15:00:00-05:00"]}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'of') = 'ofrecidos', 'horarios ofrecidos');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'of') = 'calificado_pendiente_agendamiento', 'vuelve a pendiente de agendar');
select pg_temp.esperar((select v->'contacto'->>'ghl_contact_id' from ag where paso = 'of') = 'ghl_ag_1', 'guarda ghl_contact_id (AC 25)');
select pg_temp.esperar(jsonb_array_length((select v->'conversacion'->'agenda'->'ofrecidos' from ag where paso = 'of')) = 2, 'agenda guardada');

-- Horario ocupado: se limpia la oferta para volver a consultar (AC 39)
insert into ag select 'ago', app.registrar_cita((select t from ag_ids), (select c from ag_ids),
  '{"inicio": "2026-10-13T15:00:00-05:00", "modalidad": "videollamada", "zona_horaria": "America/Bogota",
    "resultado": {"confirmada": false, "motivo": "horario_no_disponible"}}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'ago') = 'agotado', 'horario agotado');
select pg_temp.esperar((select v->'conversacion'->'agenda' from ag where paso = 'ago') = '{}'::jsonb, 'oferta limpia');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'ago') = 'calificado_pendiente_agendamiento', 'sigue pendiente de agendar');

-- Reserva confirmada (AC 32), con asesor enlazado por ghl_user_id
insert into app.asesores (tenant_id, nombre, ghl_user_id) values ((select t from ag_ids), 'Asesora GHL', 'usr_ghl_9');
select app.registrar_oferta((select t from ag_ids), (select c from ag_ids),
  '{"ofrecidos": ["2026-10-14T10:00:00-05:00"], "texto": "1. Miércoles 10 am", "motivo": "agotado"}');
insert into ag select 'ok', app.registrar_cita((select t from ag_ids), (select c from ag_ids),
  '{"inicio": "2026-10-14T10:00:00-05:00", "modalidad": "videollamada", "zona_horaria": "America/Bogota",
    "fecha_texto": "miércoles 14 de octubre", "hora_texto": "10:00 a. m.",
    "resultado": {"confirmada": true, "estado_cita": "confirmada", "id_externo": "evt_ag_1",
                  "inicio": "2026-10-14T10:00:00-05:00", "asesor_ghl_user_id": "usr_ghl_9"}}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'ok') = 'confirmada', 'cita confirmada');
select pg_temp.esperar((select v->'resultado_agenda'->>'fecha' from ag where paso = 'ok') = 'miércoles 14 de octubre', 'fecha para la plantilla');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'ok') = 'cita_confirmada', 'estado cita_confirmada');
select pg_temp.esperar((select v->'cita'->>'modalidad' from ag where paso = 'ok') = 'videollamada', 'cita en el contexto');
select pg_temp.esperar((select a.nombre from app.citas c join app.asesores a on a.id = c.asesor_id where c.id_externo = 'evt_ag_1') = 'Asesora GHL', 'asesor enlazado');
select pg_temp.esperar((select v->'conversacion'->'agenda' from ag where paso = 'ok') = '{}'::jsonb, 'oferta cerrada');

-- Reintento con la misma cita: no se duplica (AC 40)
select app.registrar_cita((select t from ag_ids), (select c from ag_ids),
  '{"inicio": "2026-10-14T10:00:00-05:00", "modalidad": "videollamada", "zona_horaria": "America/Bogota",
    "resultado": {"confirmada": true, "estado_cita": "confirmada", "id_externo": "evt_ag_1"}}');
select pg_temp.esperar((select count(*) from app.citas where id_externo = 'evt_ag_1') = 1, 'sin cita duplicada');

do $$ begin raise notice 'OK oferta, horario agotado, reserva y reintento'; end $$;

-- Calendario con confirmación manual: la cita queda pendiente --------------------
insert into ag select 'in2', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID',
  'id_externo', 'wamid.ag2', 'remitente_id', '573005550002', 'texto', 'Quiero vender'));
create temp table ag_ids2 as select ((select v->'tenant'->>'id' from ag where paso = 'in2'))::uuid as t,
                                    ((select v->'conversacion'->>'id' from ag where paso = 'in2'))::uuid as c;
select app.asignar_rol((select t from ag_ids2), (select c from ag_ids2), '{"intencion": "vender"}');
select app.guardar_evaluacion((select t from ag_ids2), (select c from ag_ids2),
  '{"evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
select app.registrar_oferta((select t from ag_ids2), (select c from ag_ids2), '{"ofrecidos": [], "texto": ""}');
select pg_temp.esperar((select estado from app.contactos where telefono = '+573005550002') = 'sin_disponibilidad', 'sin disponibilidad');
select app.registrar_oferta((select t from ag_ids2), (select c from ag_ids2),
  '{"ghl_contact_id": "ghl_ag_2", "ofrecidos": ["2026-10-15T09:00:00-05:00"], "texto": "1. Jueves 9 am"}');
insert into ag select 'pend', app.registrar_cita((select t from ag_ids2), (select c from ag_ids2),
  '{"inicio": "2026-10-15T09:00:00-05:00", "modalidad": "llamada", "zona_horaria": "America/Bogota",
    "resultado": {"confirmada": false, "estado_cita": "seleccion_pendiente", "id_externo": "evt_ag_2"}}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'pend') = 'pendiente_confirmacion', 'pendiente de confirmación');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'pend') = 'seleccion_pendiente_confirmacion', 'estado de selección pendiente');

-- Error al reservar
insert into ag select 'in3', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID',
  'id_externo', 'wamid.ag3', 'remitente_id', '573005550003', 'texto', 'Busco casa'));
select app.asignar_rol(((select v->'tenant'->>'id' from ag where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from ag where paso = 'in3'))::uuid, '{"intencion": "comprar"}');
select app.guardar_evaluacion(((select v->'tenant'->>'id' from ag where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from ag where paso = 'in3'))::uuid,
  '{"evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda", "campos_faltantes": []}}');
insert into ag select 'rerr', app.registrar_cita(((select v->'tenant'->>'id' from ag where paso = 'in3'))::uuid, ((select v->'conversacion'->>'id' from ag where paso = 'in3'))::uuid,
  '{"inicio": "2026-10-15T09:00:00-05:00", "zona_horaria": "America/Bogota",
    "resultado": {"confirmada": false, "motivo": "proveedor_no_disponible", "detalle": "502"}}');
select pg_temp.esperar((select v->'resultado_agenda'->>'tipo' from ag where paso = 'rerr') = 'error', 'error de reserva');
select pg_temp.esperar((select v->'contacto'->>'estado' from ag where paso = 'rerr') = 'error_agendamiento', 'error_agendamiento (AC 41)');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'reservar_cita' and nivel = 'error'), 'evento de reserva');

do $$ begin raise notice 'OK confirmación manual, sin disponibilidad y error de reserva'; end $$;
