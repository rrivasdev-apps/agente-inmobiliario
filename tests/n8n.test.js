'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const meta = require('../src/n8n/meta');
const geo = require('../src/n8n/geocodificacion');
const conv = require('../src/n8n/conversacion');
const { evaluarCalificacion } = require('../src/calificacion/evaluar');
const { flujo, flujoReporte, EXPRESION_TRAE_MENSAJES } = require('../scripts/generar-n8n');
const reporte = require('../src/n8n/reporte');
const { parametros } = require('../config/tenants/javier-nunez/tenant.json');

const lucia = require('../config/tenants/javier-nunez/roles/lucia.json');

function ctxBase(extra = {}) {
  return {
    tenant: { id: 't1', nombre: 'Equipo Javier Núñez', zona_horaria: 'America/Bogota' },
    canal: { id: 'k1', tipo: 'whatsapp', identificador_externo: '1234567890' },
    contacto: { id: 'c1', telefono: '+573001112233', instagram_id: null, estado: 'en_calificacion', datos: { telefono: '+573001112233' } },
    conversacion: { id: 'v1', rol_codigo: 'lucia', identificado_como_virtual: false },
    rol: { codigo: 'lucia', prompt_sistema: 'Trabajas para {{nombre_tenant}} por {{canal}}.', campos: lucia.campos, criterios: lucia.criterios, requiere_verificacion_direccion: true },
    plantillas: {
      inicio: 'Hola, soy Lucía.',
      no_calificado: 'No cumple.',
      direccion_ambigua: 'Dirección ambigua.',
      falla_agenda: 'No fue posible confirmar la cita.',
      seleccion_intencion: '¿Vender o comprar?',
    },
    integraciones: { llm: { modelo: 'PENDIENTE' }, geocodificacion: { region: 'co', language: 'es' } },
    historial: [{ direccion: 'entrante', remitente: 'contacto', contenido: 'Hola, quiero vender' }],
    verificacion: null,
    ...extra,
  };
}

const openaiOk = (contenido) => ({ choices: [{ message: { content: contenido } }] });

// --- Meta ------------------------------------------------------------------------

test('firma: se envía a la BD solo con formato válido', () => {
  const cuerpo = Buffer.from('{"a":1}');
  const firma = `sha256=${crypto.createHmac('sha256', 's').update(cuerpo).digest('hex')}`;
  const ok = meta.prepararFirma(cuerpo, { 'x-hub-signature-256': firma.toUpperCase().replace('SHA256', 'sha256') });
  assert.equal(ok.firma, firma);
  assert.equal(Buffer.from(ok.cuerpo_b64, 'base64').toString(), '{"a":1}');
  assert.equal(meta.prepararFirma(cuerpo, { 'x-hub-signature-256': "sha256=abc'; drop table x;--" }).firma, '');
  assert.equal(meta.prepararFirma(cuerpo, {}).firma, '');
});

test('webhook de WhatsApp: mensajes de texto e interactivos, ignora estados', () => {
  const cuerpo = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'PN1' },
      contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }],
      messages: [
        { id: 'wamid.1', from: '573001112233', type: 'text', text: { body: 'Hola' } },
        { id: 'wamid.2', from: '573001112233', type: 'interactive', interactive: { button_reply: { title: 'Vender' } } },
        { id: 'wamid.3', from: '573001112233', type: 'image', image: {} },
      ],
      statuses: [{ id: 'wamid.0', status: 'read' }],
    } }] }],
  };
  const m = meta.normalizarWebhook(cuerpo);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { tipo_canal: 'whatsapp', identificador_canal: 'PN1', id_externo: 'wamid.1', remitente_id: '573001112233', nombre: 'Ana', texto: 'Hola', tipo_mensaje: 'text' });
  assert.equal(m[1].texto, 'Vender');
  assert.equal(m[2].texto, null);
  assert.deepEqual(meta.normalizarWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, statuses: [{}] } }] }] }), []);
});

test('webhook de Instagram: DM y comentarios, ignora ecos y respuestas propias', () => {
  const cuerpo = {
    object: 'instagram',
    entry: [{
      id: 'IG1',
      messaging: [
        { sender: { id: 'U1' }, recipient: { id: 'IG1' }, message: { mid: 'm1', text: 'Busco casa' } },
        { sender: { id: 'IG1' }, recipient: { id: 'U1' }, message: { mid: 'm2', text: 'eco', is_echo: true } },
        { sender: { id: 'U1' }, recipient: { id: 'IG1' }, read: { mid: 'm1' } },
      ],
      changes: [
        { field: 'comments', value: { id: 'C1', text: 'Precio?', from: { id: 'U2', username: 'ana' } } },
        { field: 'comments', value: { id: 'C2', text: 'Te escribimos', from: { id: 'IG1', username: 'equipo' } } },
      ],
    }],
  };
  const m = meta.normalizarWebhook(cuerpo);
  assert.deepEqual(m.map((x) => [x.tipo_canal, x.id_externo]), [['instagram_dm', 'm1'], ['instagram_comentario', 'C1']]);
  assert.equal(m[0].identificador_canal, 'IG1');
  assert.deepEqual(meta.normalizarWebhook({ object: 'page', entry: [] }), []);
  assert.deepEqual(meta.normalizarWebhook(null), []);
});

test('envío por WhatsApp e Instagram y lectura de la respuesta', () => {
  const wa = meta.solicitudEnvio(ctxBase(), 'Hola');
  assert.equal(wa.url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(wa.cuerpo.to, '573001112233');
  assert.equal(wa.cuerpo.text.body, 'Hola');

  const ig = meta.solicitudEnvio(ctxBase({ canal: { tipo: 'instagram_dm' }, contacto: { instagram_id: 'U1' } }), 'Hola');
  assert.deepEqual(ig.cuerpo, { recipient: { id: 'U1' }, message: { text: 'Hola' } });
  assert.throws(() => meta.solicitudEnvio(ctxBase({ canal: { tipo: 'facebook_messenger' } }), 'x'), /sin envío/);

  assert.deepEqual(meta.interpretarEnvio({ messages: [{ id: 'wamid.9' }] }), { enviado: true, id_externo: 'wamid.9', error: null });
  assert.equal(meta.interpretarEnvio({ recipient_id: 'U1', message_id: 'mid.9' }).id_externo, 'mid.9');
  const fallo = meta.interpretarEnvio({ error: { message: 'Invalid OAuth access token', httpCode: '401' } });
  assert.equal(fallo.enviado, false);
  assert.equal(fallo.error.mensaje, 'Invalid OAuth access token');
});

// --- Google Maps ------------------------------------------------------------------

const resultado = (extra = {}) => ({
  formatted_address: 'Cl. 63 #9-15, Bogotá, Colombia',
  place_id: 'P1',
  geometry: { location: { lat: 4.65, lng: -74.06 }, location_type: 'ROOFTOP' },
  address_components: [{ long_name: 'Bogotá, D.C.', types: ['locality', 'political'] }],
  ...extra,
});

test('geocodificación: verificada solo con precisión, un resultado y la ciudad declarada', () => {
  const v = geo.clasificarGeocodificacion({ status: 'OK', results: [resultado()] }, 'Bogota');
  assert.equal(v.resultado, 'verificada');
  assert.equal(v.direccion_normalizada, 'Cl. 63 #9-15, Bogotá, Colombia');
  assert.equal(v.latitud, 4.65);

  const casos = [
    [{ status: 'OK', results: [resultado(), resultado()] }, 'ambigua'],
    [{ status: 'OK', results: [resultado({ partial_match: true })] }, 'ambigua'],
    [{ status: 'OK', results: [resultado({ geometry: { location: { lat: 1, lng: 1 }, location_type: 'APPROXIMATE' } })] }, 'ambigua'],
    [{ status: 'OK', results: [resultado({ address_components: [{ long_name: 'Medellín', types: ['locality'] }] })] }, 'ambigua'],
    [{ status: 'ZERO_RESULTS', results: [] }, 'sin_resultados'],
    [{ status: 'REQUEST_DENIED', error_message: 'API key invalid' }, 'error'],
    [{ error: { message: 'timeout' } }, 'error'],
  ];
  for (const [respuesta, esperado] of casos) {
    assert.equal(geo.clasificarGeocodificacion(respuesta, 'Bogotá').resultado, esperado, JSON.stringify(respuesta));
  }
  assert.equal(geo.clasificarGeocodificacion({ status: 'REQUEST_DENIED', error_message: 'x' }).respuesta_proveedor.error_message, 'x');
});

test('geocodificación: la solicitud no incluye la clave de API', () => {
  const s = geo.solicitudGeocodificacion('Cl 63 # 9-15, Chapinero, Bogotá', { region: 'co', language: 'es' });
  assert.deepEqual(s.consulta, { address: 'Cl 63 # 9-15, Chapinero, Bogotá', region: 'co', language: 'es' });
  assert.ok(!('key' in s.consulta));
});

// --- Conversación ------------------------------------------------------------------

test('clasificación: solo vender/comprar con confianza suficiente', () => {
  const s = conv.solicitudClasificacion(ctxBase(), 'PROMPT');
  assert.equal(s.model, 'gpt-4.1-mini');
  assert.equal(s.messages[0].content, 'PROMPT');
  assert.equal(conv.interpretarClasificacion(openaiOk('{"intencion":"vender","confianza":0.9}')).intencion, 'vender');
  assert.equal(conv.interpretarClasificacion(openaiOk('{"intencion":"comprar","confianza":0.5}')).intencion, 'ambigua');
  assert.equal(conv.interpretarClasificacion(openaiOk('{"intencion":"arrendar","confianza":1}')).intencion, 'ambigua');
  const fallo = conv.interpretarClasificacion({ error: { message: 'Rate limit' } });
  assert.equal(fallo.intencion, 'ambigua');
  assert.equal(fallo.eventos[0].operacion, 'clasificar_intencion');
});

test('extracción: describe los campos del rol y tolera fallas', () => {
  const s = conv.solicitudExtraccion(ctxBase({ integraciones: { llm: { modelo: 'gpt-x' } } }));
  assert.equal(s.model, 'gpt-x');
  assert.match(s.messages[0].content, /relacion_inmueble \(una de: propietario, copropietario/);
  assert.equal(s.messages.at(-1).content, 'Hola, quiero vender');
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Ana"}}')), { datos: { nombre: 'Ana' }, seleccion: null, eventos: [] });
  assert.doesNotMatch(s.messages[0].content, /seleccion/);
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('no es json')).datos, {});
  assert.equal(conv.interpretarExtraccion(openaiOk('{"datos":[1]}')).datos.constructor, Object);
});

test('evaluación del turno con el evaluador real; configuración inválida no descarta', () => {
  const ok = conv.evaluarTurno(ctxBase(), evaluarCalificacion);
  assert.equal(ok.evaluacion.accion, 'solicitar_datos');
  const malo = conv.evaluarTurno(ctxBase({ rol: { ...ctxBase().rol, criterios: { reglas: 'x' } } }), evaluarCalificacion);
  assert.equal(malo.evaluacion.resultado, 'informacion_incompleta');
  assert.equal(malo.eventos[0].nivel, 'error');
});

test('respuesta: plantillas fijas para decisiones sensibles', () => {
  assert.equal(conv.planificarRespuesta(ctxBase({ rol: null })).respuesta_fija.plantilla, 'seleccion_intencion');
  assert.equal(conv.planificarRespuesta(ctxBase({ evaluacion: { accion: 'archivar' } })).respuesta_fija.texto, 'No cumple.');
  assert.equal(conv.planificarRespuesta(ctxBase({ evaluacion: { accion: 'aclarar_direccion' } })).respuesta_fija.plantilla, 'direccion_ambigua');
});

test('respuesta: plantillas según el resultado del agendamiento', () => {
  const plantillas = {
    ...ctxBase().plantillas,
    calificado: 'Elige: {{horarios_disponibles}}',
    horario_agotado: 'Alternativas: {{horarios_alternativos}}',
    confirmacion: 'Cita el {{fecha}} a las {{hora}}, zona horaria {{zona_horaria}}, mediante {{modalidad}}.',
  };
  const plan = (ra) => conv.planificarRespuesta(ctxBase({ plantillas, evaluacion: { accion: 'ofrecer_agenda' }, resultado_agenda: ra }));
  assert.equal(plan({ tipo: 'ofrecidos', texto: '1. Lunes' }).respuesta_fija.texto, 'Elige: 1. Lunes');
  assert.equal(plan({ tipo: 'agotado', texto: '1. Martes' }).respuesta_fija.texto, 'Alternativas: 1. Martes');
  assert.equal(
    plan({ tipo: 'confirmada', fecha: 'lunes 12 de octubre', hora: '9:00 a. m.', zona_horaria: 'America/Bogota', zona_texto: 'Colombia', modalidad: 'llamada' }).respuesta_fija.texto,
    'Cita el lunes 12 de octubre a las 9:00 a. m., zona horaria Colombia, mediante llamada.',
  );
  assert.equal(plan({ tipo: 'error' }).respuesta_fija.plantilla, 'falla_agenda');
  assert.equal(plan({ tipo: 'sin_disponibilidad' }).respuesta_fija.plantilla, 'falla_agenda');
  assert.match(plan({ tipo: 'pendiente_confirmacion' }).solicitud_llm.messages[0].content, /debe confirmarla/);
});

test('respuesta: tras ofrecer horarios o calificar como no apto, responde el LLM sin repetir la plantilla', () => {
  const pendiente = conv.planificarRespuesta(ctxBase({
    conversacion: { id: 'v1', rol_codigo: 'lucia', identificado_como_virtual: true, agenda: { ofrecidos: ['x'], texto: '1. Lunes 9 am' } },
    evaluacion: { accion: 'ofrecer_agenda' },
  }));
  assert.equal(pendiente.respuesta_fija, null);
  assert.match(pendiente.solicitud_llm.messages[0].content, /número del horario[\s\S]*1\. Lunes 9 am/);

  const conCita = conv.planificarRespuesta(ctxBase({
    cita: { estado: 'confirmada', inicio: '2026-10-12T09:00:00-05:00', modalidad: 'llamada' },
    evaluacion: { accion: 'ofrecer_agenda' },
  }));
  assert.match(conCita.solicitud_llm.messages[0].content, /ya tiene una cita confirmada/);

  const archivado = conv.planificarRespuesta(ctxBase({ estado_anterior: 'no_calificado', evaluacion: { accion: 'archivar' } }));
  assert.equal(archivado.respuesta_fija, null);
  assert.match(archivado.solicitud_llm.messages[0].content, /No expliques los criterios internos/);

  // Primer turno como no apto: sí va la plantilla.
  const primera = conv.planificarRespuesta(ctxBase({ estado_anterior: 'informacion_incompleta', evaluacion: { accion: 'archivar' } }));
  assert.equal(primera.respuesta_fija.plantilla, 'no_calificado');
});

test('extracción: con horarios ofrecidos pide la selección', () => {
  const ctx = ctxBase({
    conversacion: { id: 'v1', rol_codigo: 'lucia', identificado_como_virtual: true, agenda: { ofrecidos: ['a', 'b'], texto: '1. Lunes\n2. Martes' } },
    integraciones: { llm: {}, calendario: { modalidades: { llamada: 'phone', videollamada: 'gmeet' } } },
  });
  const sistema = conv.solicitudExtraccion(ctx).messages[0].content;
  assert.match(sistema, /1\. Lunes\n2\. Martes/);
  assert.match(sistema, /una de: llamada, videollamada/);
  const r = conv.interpretarExtraccion(openaiOk('{"datos":{},"seleccion":{"horario":2,"modalidad":"videollamada"}}'));
  assert.deepEqual(r.seleccion, { horario: 2, modalidad: 'videollamada' });
});

test('respuesta redactada: estado del sistema, presentación y siguiente dato', () => {
  const plan = conv.planificarRespuesta(ctxBase({ evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['relacion_inmueble', 'ciudad'] } }));
  assert.equal(plan.respuesta_fija, null);
  const sistema = plan.solicitud_llm.messages[0].content;
  assert.match(sistema, /^Trabajas para Equipo Javier Núñez por WhatsApp\./);
  assert.match(sistema, /Pide solo el siguiente dato: Relación con el inmueble\./);
  assert.match(sistema, /Preséntate como en esta plantilla/);

  const yaPresentada = conv.planificarRespuesta(ctxBase({
    conversacion: { id: 'v1', rol_codigo: 'lucia', identificado_como_virtual: true },
    evaluacion: { accion: 'reintentar_verificacion', campos_faltantes: [] },
  }));
  assert.doesNotMatch(yaPresentada.solicitud_llm.messages[0].content, /Preséntate/);
  assert.match(yaPresentada.solicitud_llm.messages[0].content, /revisar la dirección/);

  assert.equal(conv.interpretarRedaccion(openaiOk('"Hola Ana"')).texto, 'Hola Ana');
  const fallo = conv.interpretarRedaccion({ error: { message: 'timeout' } });
  assert.equal(fallo.texto, conv.RESPUESTA_SEGURA);
  assert.equal(fallo.eventos[0].operacion, 'redactar_respuesta');
});

// --- Flujo generado -----------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const nodoPorNombre = (n) => flujo.nodes.find((x) => x.name === n);

/** Ejecuta un nodo Code "por ítem" con $json y $('Nodo').item simulados. */
function ejecutarCode(nombre, $json, previos = {}) {
  const fn = new AsyncFunction('$json', '$', 'Buffer', nodoPorNombre(nombre).parameters.jsCode);
  return fn($json, (n) => ({ item: { json: previos[n] } }), Buffer);
}

const decodificar = (b64) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

test('flujo: conexiones válidas y todos los nodos alcanzables', () => {
  const nombres = new Set(flujo.nodes.map((n) => n.name));
  assert.equal(nombres.size, flujo.nodes.length, 'nombres de nodo únicos');
  const alcanzados = new Set();
  for (const [desde, c] of Object.entries(flujo.connections)) {
    assert.ok(nombres.has(desde), desde);
    for (const salida of c.main) for (const d of salida) { assert.ok(nombres.has(d.node), d.node); alcanzados.add(d.node); }
  }
  const disparadores = flujo.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => n.name);
  for (const n of nombres) assert.ok(alcanzados.has(n) || disparadores.includes(n), `nodo huérfano: ${n}`);
});

test('flujo: el código de los nodos Code compila', () => {
  for (const n of flujo.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$json', '$input', '$', 'Buffer', n.parameters.jsCode), n.name);
  }
});

test('flujo: las consultas SQL no interpolan texto del usuario', () => {
  for (const n of flujo.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
    const expresiones = n.parameters.query.match(/\{\{[^}]*\}\}/g) || [];
    for (const e of expresiones) {
      assert.match(e, /^\{\{ \$json\.(payload_b64|token_b64|cuerpo_b64|firma|t|c) \}\}$/, `${n.name}: ${e}`);
    }
  }
});

test('flujo: el nodo de evaluación usa el evaluador incrustado', async () => {
  const ctx = ctxBase({
    contacto: { id: 'c1', estado: 'en_calificacion', datos: {
      nombre: 'Ana', telefono: '+573001112233', operacion: 'venta', ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
      tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', intencion_venta: true, plazo_meses: 12 } },
    verificacion: { resultado: 'verificada' },
  });
  ctx.tenant.parametros = parametros;
  const salida = await ejecutarCode('Evaluar calificación', { r: ctx });
  assert.equal(salida.json.t, 't1');
  assert.equal(salida.json.c, 'v1');
  const ev = decodificar(salida.json.payload_b64).evaluacion;
  assert.equal(ev.resultado, 'calificado');
  assert.equal(ev.prioridad, 'baja', 'usa los parámetros del tenant (umbral 3 meses)');
});

test('flujo: de la redacción al envío', async () => {
  const ctx = ctxBase({ evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['nombre'] } });
  const plan = (await ejecutarCode('Planificar respuesta', { r: ctx })).json;
  const redaccion = (await ejecutarCode('Interpretar redacción', openaiOk('Hola, soy Lucía. ¿Cuál es tu nombre?'), { 'Planificar respuesta': plan })).json;
  const envio = (await ejecutarCode('Preparar envío', redaccion)).json;
  assert.equal(envio.envio.cuerpo.text.body, 'Hola, soy Lucía. ¿Cuál es tu nombre?');
  const resultadoEnvio = (await ejecutarCode('Resultado del envío', { messages: [{ id: 'wamid.out' }] }, { 'Preparar envío': envio })).json;
  assert.deepEqual(decodificar(resultadoEnvio.payload_b64), {
    texto: 'Hola, soy Lucía. ¿Cuál es tu nombre?', plantilla: null, eventos: [], enviado: true, id_externo: 'wamid.out', error: null,
  });
});

test('flujo: los avisos de estado de Meta se descartan antes de los nodos Code', () => {
  const trae = new Function('$json', `return ${EXPRESION_TRAE_MENSAJES};`);
  const wa = (value) => ({ body: { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] } });
  assert.equal(trae(wa({ messages: [{ id: 'w1' }] })), true);
  assert.equal(trae(wa({ statuses: [{ status: 'read' }] })), false);
  assert.equal(trae({ body: { object: 'instagram', entry: [{ messaging: [{ message: { mid: 'm1', text: 'hola' } }] }] } }), true);
  assert.equal(trae({ body: { object: 'instagram', entry: [{ messaging: [{ message: { mid: 'm2', is_echo: true } }, { read: {} }] }] } }), false);
  assert.equal(trae({ body: { object: 'instagram', entry: [{ changes: [{ field: 'comments', value: { id: 'c1' } }] }] } }), true);
  assert.equal(trae({ body: {} }), false);
  assert.equal(trae({}), false);

  const destinos = flujo.connections['Meta: eventos (POST)'].main[0].map((d) => d.node);
  assert.deepEqual(destinos, ['¿Trae mensajes?']);
  for (const n of flujo.nodes.filter((x) => x.type === 'n8n-nodes-base.code' && x.name !== 'Rechazar firma inválida')) {
    assert.equal(n.retryOnFail, true, n.name);
  }
});

test('flujo: el plan de agenda usa la selección extraída en el turno', async () => {
  const ctx = ctxBase({
    contacto: { id: 'c1', estado: 'calificado_pendiente_agendamiento', datos: {} },
    conversacion: { id: 'v1', rol_codigo: 'lucia', agenda: { ofrecidos: ['2026-10-12T09:00:00-05:00', '2026-10-13T15:00:00-05:00'] } },
    integraciones: { calendario: { modalidades: { llamada: 'phone', videollamada: 'gmeet' } } },
    evaluacion: { resultado: 'calificado', accion: 'ofrecer_agenda' },
  });
  const salida = await ejecutarCode('Planificar agenda', { r: ctx }, { 'Registrar datos': { r: { seleccion: { horario: 2, modalidad: 'videollamada' } } } });
  assert.deepEqual(salida.json.plan, { paso: 'reservar', inicio: '2026-10-13T15:00:00-05:00', modalidad: 'videollamada' });
  const crear = flujo.nodes.find((n) => n.name === 'GHL: crear cita');
  assert.equal(crear.retryOnFail, false, 'crear cita no se reintenta');
});

// --- Prioridad baja y dossier ------------------------------------------------------

test('prioridad baja: plantilla una sola vez, con dossier si está configurado', () => {
  const plantillas = { ...ctxBase().plantillas, prioridad_baja: 'Quedas registrado.' };
  const sinDossier = conv.planificarRespuesta(ctxBase({ plantillas, evaluacion: { accion: 'nutrir' }, estado_anterior: 'informacion_incompleta' }));
  assert.equal(sinDossier.respuesta_fija.plantilla, 'prioridad_baja');
  assert.equal(sinDossier.respuesta_fija.documento, undefined);

  const conDossier = conv.planificarRespuesta(ctxBase({
    plantillas,
    tenant: { ...ctxBase().tenant, parametros: { dossier: { lucia: { url: 'https://x.co/d.pdf', nombre_archivo: 'JNdelT.pdf' } } } },
    evaluacion: { accion: 'nutrir' },
  }));
  assert.deepEqual(conDossier.respuesta_fija.documento, { url: 'https://x.co/d.pdf', nombre_archivo: 'JNdelT.pdf' });

  const despues = conv.planificarRespuesta(ctxBase({ plantillas, evaluacion: { accion: 'nutrir' }, estado_anterior: 'nutricion' }));
  assert.equal(despues.respuesta_fija, null);
  assert.match(despues.solicitud_llm.messages[0].content, /No ofrezcas ni agendes citas/);
});

test('prioridad baja no se agenda', () => {
  const agenda = require('../src/n8n/agenda');
  assert.deepEqual(agenda.planificarAgenda(ctxBase({ evaluacion: { resultado: 'calificado', accion: 'nutrir' }, conversacion: { agenda: {} } }), null), { paso: null });
});

test('envío de dossier: archivo en WhatsApp, enlace en Instagram', () => {
  const doc = { url: 'https://x.co/d.pdf', nombre_archivo: 'JNdelT.pdf' };
  const wa = meta.solicitudEnvio(ctxBase(), 'Te comparto información', doc);
  assert.equal(wa.cuerpo.type, 'document');
  assert.deepEqual(wa.cuerpo.document, { link: doc.url, filename: 'JNdelT.pdf', caption: 'Te comparto información' });
  const ig = meta.solicitudEnvio(ctxBase({ canal: { tipo: 'instagram_dm' }, contacto: { instagram_id: 'U1' } }), 'Hola', doc);
  assert.equal(ig.cuerpo.message.text, 'Hola\n\nhttps://x.co/d.pdf');
});

// --- Reporte semanal ----------------------------------------------------------------

test('reporte: tablas con motivo y plazo, escapa HTML y no envía sin destinatarios', () => {
  const fila = { tenant: { nombre: 'JNdelT', zona_horaria: 'America/Bogota' }, desde: '2026-10-02T12:00:00Z', hasta: '2026-10-09T12:00:00Z',
    destinatarios: ['admin@x.co', 'no-es-correo'],
    no_calificados: [{ fecha: '2026-10-05T15:00:00Z', nombre: '<b>Ana</b>', telefono: '+573001', canal: 'whatsapp', rol: 'sonia', operacion: 'compra', motivo: 'Busca fuera de la zona de cobertura' }],
    prioridad_baja: [{ fecha: '2026-10-06T15:00:00Z', nombre: 'Pablo', rol: 'lucia', plazo_meses: '12', estado_actual: 'nutricion' }] };
  const r = reporte.armarReporte(fila);
  assert.equal(r.enviar, true);
  assert.equal(r.para, 'admin@x.co');
  assert.match(r.asunto, /1 no calificados, 1 de prioridad baja/);
  assert.match(r.html, /Busca fuera de la zona de cobertura/);
  assert.match(r.html, /&lt;b&gt;Ana&lt;\/b&gt;/);
  assert.match(r.html, /<td[^>]*>12<\/td>/);
  assert.equal(reporte.armarReporte({ ...fila, destinatarios: [] }).enviar, false);
});

test('flujo de reporte: programado semanal en hora de Bogotá y conexiones válidas', async () => {
  assert.equal(flujoReporte.settings.timezone, 'America/Bogota');
  const nombres = new Set(flujoReporte.nodes.map((n) => n.name));
  for (const [desde, c] of Object.entries(flujoReporte.connections)) {
    assert.ok(nombres.has(desde));
    for (const salida of c.main) for (const d of salida) assert.ok(nombres.has(d.node), d.node);
  }
  const armar = flujoReporte.nodes.find((n) => n.name === 'Armar correo');
  const fn = new AsyncFunction('$json', armar.parameters.jsCode);
  const out = await fn({ r: { tenant: { nombre: 'T', zona_horaria: 'America/Bogota' }, desde: '2026-10-02T12:00:00Z', hasta: '2026-10-09T12:00:00Z', destinatarios: [], no_calificados: [], prioridad_baja: [] } });
  assert.equal(out.json.enviar, false);
  // El flujo principal no comparte nodos con el de reporte.
  assert.ok(!flujo.nodes.some((n) => n.name === 'Armar correo'));
});
