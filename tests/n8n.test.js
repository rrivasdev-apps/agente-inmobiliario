'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const meta = require('../src/n8n/meta');
const geo = require('../src/n8n/geocodificacion');
const conv = require('../src/n8n/conversacion');
const { evaluarCalificacion } = require('../src/calificacion/evaluar');
const { flujo } = require('../scripts/generar-n8n');

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
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Ana"}}')), { datos: { nombre: 'Ana' }, eventos: [] });
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
  const agenda = conv.planificarRespuesta(ctxBase({ evaluacion: { accion: 'ofrecer_agenda' } }));
  assert.equal(agenda.respuesta_fija.plantilla, 'falla_agenda');
  assert.equal(agenda.eventos[0].operacion, 'agendamiento');
});

test('respuesta: la plantilla de agenda o de no calificado se envía una sola vez', () => {
  const agenda = conv.planificarRespuesta(ctxBase({ estado_anterior: 'calificado_pendiente_agendamiento', evaluacion: { accion: 'ofrecer_agenda' } }));
  assert.equal(agenda.respuesta_fija, null);
  assert.deepEqual(agenda.eventos, []);
  assert.match(agenda.solicitud_llm.messages[0].content, /horario aún no está reservado/);

  const archivado = conv.planificarRespuesta(ctxBase({ estado_anterior: 'no_calificado', evaluacion: { accion: 'archivar' } }));
  assert.equal(archivado.respuesta_fija, null);
  assert.match(archivado.solicitud_llm.messages[0].content, /No expliques los criterios internos/);

  // Primer turno tras calificar: sí va la plantilla.
  const primera = conv.planificarRespuesta(ctxBase({ estado_anterior: 'informacion_incompleta', evaluacion: { accion: 'ofrecer_agenda' } }));
  assert.equal(primera.respuesta_fija.plantilla, 'falla_agenda');
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
      nombre: 'Ana', telefono: '+573001112233', ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
      tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', intencion_venta: true } },
    verificacion: { resultado: 'verificada' },
  });
  const salida = await ejecutarCode('Evaluar calificación', { r: ctx });
  assert.equal(salida.json.t, 't1');
  assert.equal(salida.json.c, 'v1');
  assert.equal(decodificar(salida.json.payload_b64).evaluacion.resultado, 'calificado');
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
