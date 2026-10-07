-- Pruebas de las funciones que usa el flujo de n8n (migración 0002).
\set ON_ERROR_STOP on

create or replace function pg_temp.debe_fallar(p_sql text, p_patron text)
returns void language plpgsql as $$
declare
  v_fallo boolean := false;
begin
  begin
    execute p_sql;
  exception when others then
    v_fallo := true;
    if sqlerrm not like '%' || p_patron || '%' then
      raise exception 'Error inesperado para "%": %', p_sql, sqlerrm;
    end if;
  end;
  if not v_fallo then
    raise exception 'Se esperaba un error que contenga "%" para: %', p_patron, p_sql;
  end if;
end;
$$;

create or replace function pg_temp.esperar(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if p_condicion is distinct from true then
    raise exception 'Falló: %', p_mensaje;
  end if;
end;
$$;

-- Firma y token de Meta ---------------------------------------------------------
insert into vault.decrypted_secrets values ('meta_app_secret', 'secreto-app'), ('meta_verify_token', 'token-verif');

select pg_temp.esperar(app.verificar_firma_meta(
  convert_to('{"object":"whatsapp_business_account"}', 'UTF8'),
  'sha256=' || encode(hmac(convert_to('{"object":"whatsapp_business_account"}', 'UTF8'), 'secreto-app', 'sha256'), 'hex')),
  'firma válida');
select pg_temp.esperar(not app.verificar_firma_meta(
  convert_to('{"object":"alterado"}', 'UTF8'),
  'sha256=' || encode(hmac(convert_to('{"object":"whatsapp_business_account"}', 'UTF8'), 'secreto-app', 'sha256'), 'hex')),
  'cuerpo alterado');
select pg_temp.esperar(not app.verificar_firma_meta(convert_to('x', 'UTF8'), ''), 'firma vacía');
select pg_temp.esperar(not app.verificar_firma_meta(convert_to('x', 'UTF8'), null), 'firma nula');
select pg_temp.esperar(app.verificar_token_meta('token-verif'), 'token correcto');
select pg_temp.esperar(not app.verificar_token_meta('otro'), 'token incorrecto');
select pg_temp.esperar(not app.verificar_token_meta(''), 'token vacío');

do $$ begin raise notice 'OK firma y token de Meta'; end $$;

-- Mensaje entrante por WhatsApp ----------------------------------------------------
create temp table r (paso text primary key, v jsonb);

insert into r select 'wa1', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID',
  'id_externo', 'wamid.1', 'remitente_id', '573009998877', 'nombre', 'Pedro WA', 'texto', 'Hola, quiero vender mi apartamento'));

select pg_temp.esperar((select v->>'estado' from r where paso = 'wa1') = 'ok', 'mensaje nuevo');
select pg_temp.esperar((select v->'conversacion'->>'rol_codigo' from r where paso = 'wa1') is null, 'sin rol al inicio');
select pg_temp.esperar((select v->'contacto'->>'telefono' from r where paso = 'wa1') = '+573009998877', 'teléfono E.164');
select pg_temp.esperar((select v->'contacto'->'datos'->>'telefono' from r where paso = 'wa1') = '+573009998877', 'teléfono en datos');
select pg_temp.esperar((select jsonb_array_length(v->'historial') from r where paso = 'wa1') = 1, 'historial con el mensaje');
select pg_temp.esperar((select v->'plantillas' ? 'seleccion_intencion' from r where paso = 'wa1'), 'plantillas comunes');
select pg_temp.esperar(not (select v->'plantillas' ? 'inicio' from r where paso = 'wa1'), 'sin plantillas de rol');

-- AC 40: un reintento de Meta no se procesa dos veces
select pg_temp.esperar(app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID',
  'id_externo', 'wamid.1', 'remitente_id', '573009998877', 'texto', 'Hola, quiero vender mi apartamento'))->>'estado' = 'duplicado',
  'mensaje duplicado');
select pg_temp.esperar(app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'whatsapp', 'identificador_canal', 'NO_EXISTE', 'id_externo', 'wamid.x', 'remitente_id', '1', 'texto', 'x'))->>'estado'
  = 'canal_desconocido', 'canal desconocido');

-- Clasificación y rol
insert into r select 'rol', app.asignar_rol(
  ((select v->'tenant'->>'id' from r where paso = 'wa1'))::uuid,
  ((select v->'conversacion'->>'id' from r where paso = 'wa1'))::uuid,
  '{"intencion": "vender"}');
select pg_temp.esperar((select v->'conversacion'->>'rol_codigo' from r where paso = 'rol') = 'lucia', 'vender -> Lucía');
select pg_temp.esperar((select v->'rol'->>'codigo' from r where paso = 'rol') = 'lucia', 'contexto con el rol');
select pg_temp.esperar((select v->'plantillas'->>'inicio' from r where paso = 'rol') like 'Hola, soy Lucía%', 'plantilla de Lucía');
select pg_temp.esperar((select rol_origen from app.contactos where telefono = '+573009998877') = 'lucia', 'rol de origen');

-- Datos: solo claves y tipos definidos por el rol
insert into r select 'datos', app.registrar_datos(
  ((select v->'tenant'->>'id' from r where paso = 'wa1'))::uuid,
  ((select v->'conversacion'->>'id' from r where paso = 'wa1'))::uuid,
  '{"datos": {"nombre": "Pedro", "tipo_inmueble": "Apartamento", "intencion_venta": true, "relacion_inmueble": "vecino",
              "presupuesto_cop": 5, "ciudad": " Bogotá ", "barrio": "Chapinero", "direccion": "Cl 63 # 9-15", "email": null},
    "eventos": [{"nivel": "advertencia", "proveedor": "openai", "operacion": "extraer_datos", "mensaje": "prueba"}]}');
select pg_temp.esperar((select v->'contacto'->'datos'->>'tipo_inmueble' from r where paso = 'datos') = 'apartamento', 'opción normalizada');
select pg_temp.esperar((select v->'contacto'->'datos'->>'ciudad' from r where paso = 'datos') = 'Bogotá', 'texto recortado');
select pg_temp.esperar((select v->'contacto'->>'nombre' from r where paso = 'datos') = 'Pedro', 'nombre sincronizado');
select pg_temp.esperar((select v->'ignorados' from r where paso = 'datos') @> '["presupuesto_cop", "relacion_inmueble"]', 'claves rechazadas');
select pg_temp.esperar(not (select v->'contacto'->'datos' ? 'relacion_inmueble' from r where paso = 'datos'), 'opción inválida no se guarda');
select pg_temp.esperar((select v->>'direccion_a_verificar' from r where paso = 'datos') = 'Cl 63 # 9-15, Chapinero, Bogotá', 'dirección completa');
select pg_temp.esperar((select (v->>'verificacion_pendiente')::boolean from r where paso = 'datos'), 'verificación pendiente');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'extraer_datos' and nivel = 'advertencia'), 'evento registrado');

-- Verificación: sin resultados -> ambigua, error -> se reintenta, luego no_verificada
create temp table ids2 as select
  ((select v->'tenant'->>'id' from r where paso = 'wa1'))::uuid as t,
  ((select v->'conversacion'->>'id' from r where paso = 'wa1'))::uuid as c;

insert into r select 'v1', app.registrar_verificacion((select t from ids2), (select c from ids2), '{"resultado": "sin_resultados"}');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from r where paso = 'v1') = 'ambigua', 'primera vez sin resultados: ambigua');
select pg_temp.esperar(not (select (v->>'verificacion_pendiente')::boolean from r where paso = 'v1'), 'no repite la consulta');

insert into r select 'v2', app.registrar_verificacion((select t from ids2), (select c from ids2), '{"resultado": "error", "respuesta_proveedor": {"status": "UNKNOWN_ERROR"}}');
select pg_temp.esperar((select (v->>'verificacion_pendiente')::boolean from r where paso = 'v2'), 'tras un error se reintenta (AC 47)');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'verificar_direccion' and nivel = 'error'), 'error de Google Maps registrado');

insert into r select 'v3', app.registrar_verificacion((select t from ids2), (select c from ids2), '{"resultado": "sin_resultados"}');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from r where paso = 'v3') = 'no_verificada', 'tras aclaración: no_verificada');

-- Corregir la dirección vuelve a exigir verificación
insert into r select 'corr', app.registrar_datos((select t from ids2), (select c from ids2), '{"datos": {"direccion": "Calle 63 # 9-15"}}');
select pg_temp.esperar((select (v->>'verificacion_pendiente')::boolean from r where paso = 'corr'), 'dirección corregida se verifica');
insert into r select 'v4', app.registrar_verificacion((select t from ids2), (select c from ids2),
  '{"resultado": "verificada", "direccion_normalizada": "Cl. 63 #9-15, Bogotá", "latitud": 4.65, "longitud": -74.06, "place_id": "abc"}');
select pg_temp.esperar((select v->'verificacion'->>'resultado' from r where paso = 'v4') = 'verificada', 'verificada');

do $$ begin raise notice 'OK mensaje entrante, rol, datos y verificación'; end $$;

-- Evaluación y estados -------------------------------------------------------------
insert into r select 'e1', app.guardar_evaluacion((select t from ids2), (select c from ids2),
  '{"evaluacion": {"resultado": "informacion_incompleta", "accion": "solicitar_datos", "campos_faltantes": ["relacion_inmueble"], "reglas": [], "motivo": "Faltan campos"}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from r where paso = 'e1') = 'informacion_incompleta', 'información incompleta');
select pg_temp.esperar((select v->'evaluacion'->>'accion' from r where paso = 'e1') = 'solicitar_datos', 'devuelve la evaluación');

insert into r select 'e2', app.guardar_evaluacion((select t from ids2), (select c from ids2),
  '{"evaluacion": {"resultado": "calificado", "accion": "ofrecer_agenda", "campos_faltantes": [], "reglas": [{"id": "x", "cumple": true}]}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from r where paso = 'e2') = 'calificado_pendiente_agendamiento', 'calificado');

-- Una evaluación posterior no hace retroceder el estado
insert into r select 'e3', app.guardar_evaluacion((select t from ids2), (select c from ids2),
  '{"evaluacion": {"resultado": "informacion_incompleta", "accion": "solicitar_datos", "campos_faltantes": ["x"]}}');
select pg_temp.esperar((select v->'contacto'->>'estado' from r where paso = 'e3') = 'calificado_pendiente_agendamiento', 'sin retroceso');
select pg_temp.esperar((select count(*) from app.evaluaciones_calificacion where conversacion_id = (select c from ids2)) = 3, 'evaluaciones auditadas');

-- Respuesta enviada
select app.registrar_respuesta((select t from ids2), (select c from ids2), '{"texto": "Hola, soy Lucía", "plantilla": "inicio", "enviado": true, "id_externo": "wamid.out1"}');
select pg_temp.esperar((select identificado_como_virtual from app.conversaciones where id = (select c from ids2)), 'identificado como virtual (AC 09)');
select pg_temp.esperar((select plantilla_id is not null from app.mensajes where id_externo = 'wamid.out1'), 'plantilla enlazada');
select app.registrar_respuesta((select t from ids2), (select c from ids2), '{"texto": "x", "enviado": false, "error": {"code": 190}}');
select pg_temp.esperar(exists (select 1 from app.eventos where operacion = 'enviar_mensaje' and nivel = 'error'), 'falla de envío registrada (AC 46)');

do $$ begin raise notice 'OK evaluación, estados y respuesta'; end $$;

-- Instagram: DM con Sonia y comentarios -------------------------------------------
insert into r select 'ig', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'instagram_dm', 'identificador_canal', 'PENDIENTE_INSTAGRAM_ACCOUNT_ID',
  'id_externo', 'mid.1', 'remitente_id', 'igsid-1', 'texto', 'Busco apartamento'));
select pg_temp.esperar((select v->'contacto'->>'instagram_id' from r where paso = 'ig') = 'igsid-1', 'contacto de Instagram');
select app.asignar_rol(((select v->'tenant'->>'id' from r where paso = 'ig'))::uuid, ((select v->'conversacion'->>'id' from r where paso = 'ig'))::uuid, '{"intencion": "comprar"}');
-- AC 20: Sonia no verifica direcciones, aunque el flujo lo intente
select pg_temp.debe_fallar(format('select app.registrar_verificacion(%L, %L, %L)',
  (select v->'tenant'->>'id' from r where paso = 'ig'), (select v->'conversacion'->>'id' from r where paso = 'ig'), '{"resultado": "verificada"}'),
  'Solo las conversaciones de Lucía');

insert into r select 'com', app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'instagram_comentario', 'identificador_canal', 'PENDIENTE_INSTAGRAM_ACCOUNT_ID',
  'id_externo', 'comment-1', 'remitente_id', 'iguser-9', 'texto', 'Precio?'));
select pg_temp.esperar((select v->>'estado' from r where paso = 'com') = 'comentario', 'comentario');
select pg_temp.esperar((select v->>'texto' from r where paso = 'com') like '%mensaje directo%', 'plantilla de comentario (AC 08)');
select pg_temp.esperar(app.recibir_mensaje(jsonb_build_object(
  'tipo_canal', 'instagram_comentario', 'identificador_canal', 'PENDIENTE_INSTAGRAM_ACCOUNT_ID',
  'id_externo', 'comment-1', 'remitente_id', 'iguser-9', 'texto', 'Precio?'))->>'estado' = 'duplicado', 'comentario duplicado');

-- Solo n8n (service_role) puede ejecutar las funciones
set role authenticated;
select pg_temp.debe_fallar($q$select app.recibir_mensaje('{}')$q$, 'permission denied');
select pg_temp.debe_fallar($q$select app.secreto_vault('meta_app_secret')$q$, 'permission denied');
reset role;

do $$ begin raise notice 'OK Instagram, comentarios y permisos'; end $$;
