-- ARCHIVO GENERADO por scripts/generar-seed.js. No editar a mano.
-- Fuente: config/tenants/* y prompts/*

begin;
-- Tenant: Equipo Javier Núñez
insert into app.tenants (slug, nombre, zona_horaria, mercado) values ('javier-nunez', 'Equipo Javier Núñez', 'America/Bogota', 'Bogotá');
insert into app.canales (tenant_id, tipo, identificador_externo, nombre) values ((select id from app.tenants where slug = 'javier-nunez'), 'whatsapp', 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID', 'WhatsApp principal');
insert into app.canales (tenant_id, tipo, identificador_externo, nombre) values ((select id from app.tenants where slug = 'javier-nunez'), 'instagram_dm', 'PENDIENTE_INSTAGRAM_ACCOUNT_ID', 'Instagram DM');
insert into app.canales (tenant_id, tipo, identificador_externo, nombre) values ((select id from app.tenants where slug = 'javier-nunez'), 'instagram_comentario', 'PENDIENTE_INSTAGRAM_ACCOUNT_ID', 'Instagram comentarios');
insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values ((select id from app.tenants where slug = 'javier-nunez'), 'crm', 'gohighlevel', '{"location_id":"z5G219RsqFPJWLnEe5ZX"}'::jsonb, 'n8n:ghl-javier-nunez');
insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values ((select id from app.tenants where slug = 'javier-nunez'), 'calendario', 'gohighlevel_calendar', '{"location_id":"z5G219RsqFPJWLnEe5ZX","calendar_id":"iOKQp2oz67a9Bw7C2iY5","duracion_minutos":null,"modalidades":{"llamada":"phone","videollamada":"gmeet","presencial":"address"},"dias_a_consultar":7,"antelacion_minima_minutos":60,"horarios_a_ofrecer":4,"horarios_por_dia":2}'::jsonb, 'n8n:ghl-javier-nunez');
insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values ((select id from app.tenants where slug = 'javier-nunez'), 'geocodificacion', 'google_maps', '{"region":"co","language":"es"}'::jsonb, 'n8n:google-maps');
insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values ((select id from app.tenants where slug = 'javier-nunez'), 'llm', 'openai', '{"modelo":"PENDIENTE"}'::jsonb, 'n8n:openai');
insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values ((select id from app.tenants where slug = 'javier-nunez'), 'mensajeria', 'meta', '{}'::jsonb, 'n8n:meta-javier-nunez');
insert into app.roles_agente (tenant_id, codigo, nombre_visible, tipo_contacto, prompt_sistema, campos, criterios, requiere_verificacion_direccion, etiqueta_crm) values ((select id from app.tenants where slug = 'javier-nunez'), 'lucia', 'Lucía', 'propietario', '## Reglas comunes (se anteponen al prompt de cada rol)

Trabajas para {{nombre_tenant}}. Atiendes conversaciones por {{canal}}.

1. En tu primer mensaje te presentas como asistente virtual. Nunca afirmes ser una persona.
2. Escribes en español, con frases breves y una sola pregunta por mensaje.
3. Usas la información que la persona ya dio. No repites preguntas resueltas.
4. Si la persona corrige un dato, el sistema lo actualiza; confírmalo brevemente.
5. Nunca inventas datos. Si una respuesta es ambigua, pides una aclaración concreta.
6. Tú no decides si la persona califica. El sistema registra los datos, verifica la dirección y evalúa la calificación; en cada turno te indica la `accion` y los campos faltantes:
   - `solicitar_datos`: pide el siguiente campo faltante.
   - `reintentar_verificacion`: informa que vas a revisar la dirección y no descartes a la persona.
   - Las respuestas de dirección ambigua, no calificado y agenda las envía el sistema con plantillas aprobadas. No expliques los criterios internos.
7. Una cita solo está confirmada cuando el sistema confirma la reserva con el proveedor. Antes de eso:
   - no digas que un asesor se comunicará;
   - di que el siguiente paso es reservar.
8. Nunca inventes un horario ni ofrezcas horarios que el sistema no te haya dado.
9. No pidas documentos, números de matrícula ni datos bancarios.
10. No des opiniones sobre precios, avalúos ni asesoría legal o tributaria.
11. Si la persona pide hablar con un humano, indica que el siguiente paso es reservar con un asesor y ofrece la agenda si ya calificó.

## Rol: Lucía, asistente virtual para propietarios

Eres Lucía, la asistente virtual de {{nombre_tenant}}. Atiendes a personas que quieren vender un inmueble.

Tu objetivo es reunir estos datos, en una conversación natural y sin formularios:
- nombre: Nombre (Nombre de la persona)
- telefono: Teléfono (Teléfono en formato internacional. En WhatsApp se toma del canal; en Instagram se pregunta.)
- email: Correo (Correo electrónico, solo si la persona lo ofrece)
- ciudad: Ciudad (Ciudad donde está el inmueble)
- barrio: Sector o barrio (Sector o barrio del inmueble)
- direccion: Dirección (Dirección del inmueble tal como la escribe la persona)
- tipo_inmueble: Tipo de inmueble
- relacion_inmueble: Relación con el inmueble
- intencion_venta: Intención de vender (true solo si la persona expresa que quiere vender o evaluar la venta)

Orden sugerido: nombre, tipo de inmueble, relación con el inmueble, ciudad y barrio, dirección, intención de vender.

Verificación de dirección:
- Cuando tengas ciudad, barrio y dirección, el sistema la verifica en Google Maps.
- La verificación solo confirma que la ubicación existe. Nunca la presentes como prueba de propiedad ni de autorización para vender.
- Si la dirección es ambigua, pide ciudad, barrio, una referencia o una corrección.', '[{"clave":"nombre","etiqueta":"Nombre","tipo":"texto","descripcion":"Nombre de la persona"},{"clave":"telefono","etiqueta":"Teléfono","tipo":"texto","descripcion":"Teléfono en formato internacional. En WhatsApp se toma del canal; en Instagram se pregunta."},{"clave":"email","etiqueta":"Correo","tipo":"texto","descripcion":"Correo electrónico, solo si la persona lo ofrece"},{"clave":"ciudad","etiqueta":"Ciudad","tipo":"texto","descripcion":"Ciudad donde está el inmueble"},{"clave":"barrio","etiqueta":"Sector o barrio","tipo":"texto","descripcion":"Sector o barrio del inmueble"},{"clave":"direccion","etiqueta":"Dirección","tipo":"texto","descripcion":"Dirección del inmueble tal como la escribe la persona"},{"clave":"tipo_inmueble","etiqueta":"Tipo de inmueble","tipo":"opcion","opciones":["apartamento","casa","lote","local","oficina","bodega","otro"]},{"clave":"relacion_inmueble","etiqueta":"Relación con el inmueble","tipo":"opcion","opciones":["propietario","copropietario","apoderado","familiar","conocido","otro"]},{"clave":"intencion_venta","etiqueta":"Intención de vender","tipo":"booleano","descripcion":"true solo si la persona expresa que quiere vender o evaluar la venta"}]'::jsonb, '{"campos_obligatorios":["nombre","telefono","ciudad","barrio","direccion","tipo_inmueble","relacion_inmueble","intencion_venta"],"reglas":[{"id":"intencion_venta","campo":"intencion_venta","operador":"igual","valor":true,"motivo":"No manifestó intención de vender"},{"id":"relacion_valida","campo":"relacion_inmueble","operador":"en","valor":["propietario","copropietario","apoderado"],"motivo":"La relación declarada con el inmueble no cumple los criterios"},{"id":"mercado_ciudad","campo":"ciudad","operador":"en","valor":["Bogotá"],"motivo":"El inmueble está fuera del mercado atendido"},{"id":"tipo_inmueble","campo":"tipo_inmueble","operador":"en","valor":["apartamento","casa","lote","local","oficina","bodega"],"motivo":"El tipo de inmueble no se atiende"}]}'::jsonb, true, 'agente-lucia');
insert into app.roles_agente (tenant_id, codigo, nombre_visible, tipo_contacto, prompt_sistema, campos, criterios, requiere_verificacion_direccion, etiqueta_crm) values ((select id from app.tenants where slug = 'javier-nunez'), 'sonia', 'Sonia', 'comprador', '## Reglas comunes (se anteponen al prompt de cada rol)

Trabajas para {{nombre_tenant}}. Atiendes conversaciones por {{canal}}.

1. En tu primer mensaje te presentas como asistente virtual. Nunca afirmes ser una persona.
2. Escribes en español, con frases breves y una sola pregunta por mensaje.
3. Usas la información que la persona ya dio. No repites preguntas resueltas.
4. Si la persona corrige un dato, el sistema lo actualiza; confírmalo brevemente.
5. Nunca inventas datos. Si una respuesta es ambigua, pides una aclaración concreta.
6. Tú no decides si la persona califica. El sistema registra los datos, verifica la dirección y evalúa la calificación; en cada turno te indica la `accion` y los campos faltantes:
   - `solicitar_datos`: pide el siguiente campo faltante.
   - `reintentar_verificacion`: informa que vas a revisar la dirección y no descartes a la persona.
   - Las respuestas de dirección ambigua, no calificado y agenda las envía el sistema con plantillas aprobadas. No expliques los criterios internos.
7. Una cita solo está confirmada cuando el sistema confirma la reserva con el proveedor. Antes de eso:
   - no digas que un asesor se comunicará;
   - di que el siguiente paso es reservar.
8. Nunca inventes un horario ni ofrezcas horarios que el sistema no te haya dado.
9. No pidas documentos, números de matrícula ni datos bancarios.
10. No des opiniones sobre precios, avalúos ni asesoría legal o tributaria.
11. Si la persona pide hablar con un humano, indica que el siguiente paso es reservar con un asesor y ofrece la agenda si ya calificó.

## Rol: Sonia, asistente virtual para compradores

Eres Sonia, la asistente virtual de {{nombre_tenant}}. Atiendes a personas que buscan comprar un inmueble.

Tu objetivo es reunir estos datos, en una conversación natural y sin formularios:
- nombre: Nombre (Nombre de la persona)
- telefono: Teléfono (Teléfono en formato internacional. En WhatsApp se toma del canal; en Instagram se pregunta.)
- email: Correo (Correo electrónico, solo si la persona lo ofrece)
- ciudad_interes: Ciudad de interés
- zonas_interes: Zonas de interés
- tipo_inmueble: Tipo de inmueble buscado
- presupuesto_cop: Presupuesto aproximado (COP) (Presupuesto máximo en pesos colombianos. Si da un rango, usar el valor máximo.)
- forma_pago: Forma de pago
- horizonte_compra_meses: Horizonte de compra (meses) (En cuántos meses espera comprar)
- intencion_compra: Intención concreta de compra (true solo si expresa intención concreta de comprar, no solo curiosidad)
- propiedad_origen: Anuncio o publicación de origen (Inmueble o anuncio que motivó el contacto, si lo menciona)

Orden sugerido: nombre, tipo de inmueble, ciudad y zonas de interés, presupuesto, forma de pago, en cuánto tiempo espera comprar.

- No verificas direcciones ni prometes disponibilidad de inmuebles específicos.', '[{"clave":"nombre","etiqueta":"Nombre","tipo":"texto","descripcion":"Nombre de la persona"},{"clave":"telefono","etiqueta":"Teléfono","tipo":"texto","descripcion":"Teléfono en formato internacional. En WhatsApp se toma del canal; en Instagram se pregunta."},{"clave":"email","etiqueta":"Correo","tipo":"texto","descripcion":"Correo electrónico, solo si la persona lo ofrece"},{"clave":"ciudad_interes","etiqueta":"Ciudad de interés","tipo":"texto"},{"clave":"zonas_interes","etiqueta":"Zonas de interés","tipo":"texto"},{"clave":"tipo_inmueble","etiqueta":"Tipo de inmueble buscado","tipo":"opcion","opciones":["apartamento","casa","lote","local","oficina","bodega","otro"]},{"clave":"presupuesto_cop","etiqueta":"Presupuesto aproximado (COP)","tipo":"numero","descripcion":"Presupuesto máximo en pesos colombianos. Si da un rango, usar el valor máximo."},{"clave":"forma_pago","etiqueta":"Forma de pago","tipo":"opcion","opciones":["contado","credito_hipotecario","leasing","subsidio","mixto","no_definido"]},{"clave":"horizonte_compra_meses","etiqueta":"Horizonte de compra (meses)","tipo":"numero","descripcion":"En cuántos meses espera comprar"},{"clave":"intencion_compra","etiqueta":"Intención concreta de compra","tipo":"booleano","descripcion":"true solo si expresa intención concreta de comprar, no solo curiosidad"},{"clave":"propiedad_origen","etiqueta":"Anuncio o publicación de origen","tipo":"texto","descripcion":"Inmueble o anuncio que motivó el contacto, si lo menciona"}]'::jsonb, '{"campos_obligatorios":["nombre","telefono","ciudad_interes","tipo_inmueble","presupuesto_cop","horizonte_compra_meses","intencion_compra"],"reglas":[{"id":"intencion_compra","campo":"intencion_compra","operador":"igual","valor":true,"motivo":"No manifestó una intención concreta de compra"},{"id":"mercado_ciudad","campo":"ciudad_interes","operador":"en","valor":["Bogotá"],"motivo":"Busca fuera del mercado atendido"},{"id":"tipo_inmueble","campo":"tipo_inmueble","operador":"en","valor":["apartamento","casa","lote","local","oficina","bodega"],"motivo":"El tipo de inmueble buscado no se atiende"},{"id":"presupuesto_minimo","campo":"presupuesto_cop","operador":"mayor_o_igual","valor":200000000,"motivo":"El presupuesto está por debajo del umbral del portafolio"},{"id":"horizonte_compra","campo":"horizonte_compra_meses","operador":"menor_o_igual","valor":6,"motivo":"El horizonte de compra supera el plazo atendido"}]}'::jsonb, false, 'agente-sonia');
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'seleccion_intencion', 'Hola, soy el asistente virtual del equipo de Javier Núñez. Para orientarte correctamente, cuéntame: ¿quieres vender una propiedad o estás buscando una propiedad para comprar?', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), 'lucia', 'inicio', 'Hola, soy Lucía, la asistente virtual del equipo de Javier Núñez. Te haré unas preguntas breves para conocer la propiedad que deseas vender y determinar el siguiente paso. ¿Cuál es tu nombre?', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), 'sonia', 'inicio', 'Hola, soy Sonia, la asistente virtual del equipo de Javier Núñez. Te haré unas preguntas breves para entender qué propiedad buscas. ¿Cuál es tu nombre?', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'comentario_instagram', '¡Hola! Gracias por escribirnos. Envíanos un mensaje directo con la palabra INFO para poder ayudarte.', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), 'lucia', 'direccion_ambigua', 'No pude identificar la dirección con suficiente precisión. ¿Podrías confirmar la ciudad, el barrio y la dirección completa o compartir un punto de referencia?', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), 'lucia', 'calificado', 'Gracias, cumples con los criterios para continuar. El siguiente paso es agendar una conversación con uno de nuestros asesores. ¿Cuál de estos horarios prefieres? {{horarios_disponibles}}', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), 'sonia', 'calificado', 'Gracias, ya contamos con la información necesaria y cumples con los criterios para continuar. Ahora puedes agendar una conversación con uno de nuestros asesores. ¿Cuál de estos horarios prefieres? {{horarios_disponibles}}', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'enlace_agenda', 'Puedes escoger el horario que mejor te convenga aquí: {{enlace_agenda}}. La cita quedará confirmada cuando completes la reserva.', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'confirmacion', 'Tu cita quedó confirmada para el {{fecha}} a las {{hora}}, zona horaria {{zona_horaria}}, mediante {{modalidad}}. El asesor asignado continuará contigo en ese momento.', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'pendiente_agenda', 'Ya completamos la calificación. Para continuar, todavía debes seleccionar una fecha y hora para conversar con un asesor: {{enlace_agenda}}.', true);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'horario_agotado', 'Ese horario ya no se encuentra disponible. Puedo ofrecerte estas alternativas: {{horarios_alternativos}}.', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'falla_agenda', 'No fue posible confirmar la cita en este momento. Tu información quedó registrada, pero el horario aún no está reservado.', false);
insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values ((select id from app.tenants where slug = 'javier-nunez'), null, 'no_calificado', 'Gracias por compartir la información. En este momento tu caso no cumple las condiciones necesarias para continuar con el proceso.', false);
commit;
