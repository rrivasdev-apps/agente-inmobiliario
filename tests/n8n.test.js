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
    conversacion: { id: 'v1', rol_codigo: 'lucia', identificado_como_virtual: true },
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
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Ana"}}')), { datos: { nombre: 'Ana' }, seleccion: null, nueva_propiedad: false, misma_cita: false, cambio_intencion: null, eventos: [] });
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
    confirmacion: 'Listo, {{encuentro}} con {{asesor}} quedó confirmada para el {{fecha}} a las {{hora}} (hora de {{zona_horaria}}). {{quien_contacta}}',
  };
  const tenant = { ...ctxBase().tenant, parametros: require('../config/tenants/javier-nunez/tenant.json').parametros };
  const plan = (ra) => conv.planificarRespuesta(ctxBase({ plantillas, tenant, evaluacion: { accion: 'ofrecer_agenda' }, resultado_agenda: ra }));
  assert.equal(plan({ tipo: 'ofrecidos', texto: '1. Lunes' }).respuesta_fija.texto, 'Elige: 1. Lunes');
  assert.equal(plan({ tipo: 'agotado', texto: '1. Martes' }).respuesta_fija.texto, 'Alternativas: 1. Martes');
  assert.equal(
    plan({ tipo: 'confirmada', fecha: 'lunes 12 de octubre', hora: '9:00 a. m.', zona_horaria: 'America/Bogota', zona_texto: 'Colombia', modalidad: 'llamada' }).respuesta_fija.texto,
    'Listo, tu llamada con Javier quedó confirmada para el lunes 12 de octubre a las 9:00 a. m. (hora de Colombia). Javier te llamará a este número.',
  );
  assert.match(plan({ tipo: 'confirmada', fecha: 'f', hora: 'h', zona_texto: 'Colombia', modalidad: 'presencial' }).respuesta_fija.texto,
    /tu visita presencial con Javier quedó confirmada/, 'distingue llamada de visita presencial');
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
    cita: { estado: 'confirmada', inicio: '2030-10-12T09:00:00-05:00', modalidad: 'llamada' },
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
  const primera = { ...ctxBase().conversacion, identificado_como_virtual: false };
  const plan = conv.planificarRespuesta(ctxBase({ conversacion: primera, evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['relacion_inmueble', 'ciudad'] } }));
  assert.equal(plan.respuesta_fija, null);
  const sistema = plan.solicitud_llm.messages[0].content;
  assert.match(sistema, /^Trabajas para Equipo Javier Núñez por WhatsApp\./);
  assert.match(sistema, /Pide permiso para hacerle unas preguntas breves/, 'primero pide permiso');
  assert.match(sistema, /Preséntate como en esta plantilla/);

  const conPermiso = conv.planificarRespuesta(ctxBase({
    contacto: { ...ctxBase().contacto, datos: { acepta_preguntas: true } },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['relacion_inmueble', 'ciudad'] },
  }));
  assert.match(conPermiso.solicitud_llm.messages[0].content, /Pide solo el siguiente dato: Relación con el inmueble\./);

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
      nombre: 'Ana Gómez', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
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
    no_calificados: [{ fecha: '2026-10-05T15:00:00Z', nombre: '<b>Ana</b>', telefono: '+573001', canal: 'whatsapp', rol: 'sonia', operacion: 'compra', motivo: 'Busca fuera de la zona de cobertura', autoriza_referencia: true }],
    prioridad_baja: [{ fecha: '2026-10-06T15:00:00Z', nombre: 'Pablo', rol: 'lucia', plazo_meses: '12', estado_actual: 'nutricion' }] };
  const r = reporte.armarReporte(fila);
  assert.equal(r.enviar, true);
  assert.equal(r.para, 'admin@x.co');
  assert.match(r.asunto, /1 no calificados, 1 de prioridad baja/);
  assert.match(r.html, /Busca fuera de la zona de cobertura/);
  assert.match(r.html, /&lt;b&gt;Ana&lt;\/b&gt;/);
  assert.match(r.html, /<td[^>]*>12<\/td>/);
  assert.match(r.html, /Autorizada \(pendiente\)/, 'la referencia autorizada queda pendiente, no realizada');
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

// --- Estilo, nombre, objeciones y nutrición de no calificados ---------------------------

test('nombre: solo nombres de persona; primer nombre sin tratamientos', () => {
  const casos = [
    ['Juan Rojas', 'Juan'], ['ana', 'Ana'], ['Dr. Andrés Pérez', 'Andrés'], ['Lucía-Fernanda Gómez', 'Lucía-Fernanda'],
    ['📱 Carlos 🏠', 'Carlos'], ['Cliente VIP', null], ['J.P.', null], ['123', null], ['Ventas Bogotá', null], ['', null], [null, null],
  ];
  for (const [entrada, esperado] of casos) assert.equal(conv.primerNombre(entrada), esperado, String(entrada));
});

test('nombre del perfil: se propone al extractor y se usa en la respuesta', () => {
  const ctx = ctxBase({ contacto: { ...ctxBase().contacto, nombre: 'Juan Rojas', datos: { telefono: '+573001112233' } } });
  assert.match(conv.solicitudExtraccion(ctx).messages[0].content, /Nombre del perfil de WhatsApp: "Juan Rojas"/);
  const plan = conv.planificarRespuesta({ ...ctx, evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['operacion'] } });
  assert.match(plan.solicitud_llm.messages[0].content, /Dirígete a la persona como "Juan"\. No le preguntes su nombre/);

  const invalido = ctxBase({ contacto: { ...ctxBase().contacto, nombre: 'Cliente 01', datos: {} } });
  assert.doesNotMatch(conv.solicitudExtraccion(invalido).messages[0].content, /Nombre del perfil/);
  const plan2 = conv.planificarRespuesta({ ...invalido, evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['nombre'] } });
  assert.match(plan2.solicitud_llm.messages[0].content, /Aún no sabes cómo se llama/);

  // El nombre que dio la persona prevalece sobre el del perfil.
  const dado = ctxBase({ contacto: { ...ctxBase().contacto, nombre: 'Juan Rojas', datos: { nombre: 'Juanita' } } });
  assert.match(conv.planificarRespuesta({ ...dado, evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['x'] } }).solicitud_llm.messages[0].content, /como "Juanita"/);
});

test('objeciones: asesor y argumento de exclusividad salen de los parámetros', () => {
  const prompt = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'prompts', 'comun.md'), 'utf8');
  const ctx = ctxBase({
    rol: { ...ctxBase().rol, prompt_sistema: prompt },
    tenant: { ...ctxBase().tenant, parametros },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['x'] },
  });
  const sistema = conv.planificarRespuesta(ctx).solicitud_llm.messages[0].content;
  assert.match(sistema, /Lo demás lo revisa Javier/);
  assert.match(sistema, /en exclusiva con Javier/);
  assert.doesNotMatch(sistema, /comisión del 5 %/, 'la comisión de venta no va en las reglas comunes (Sonia atiende compradores)');
  const lucia = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'prompts', 'lucia.md'), 'utf8');
  const sistemaLucia = conv.planificarRespuesta({ ...ctx, rol: { ...ctx.rol, prompt_sistema: `${prompt}\n\n${lucia.replace('{{campos}}', '- datos')}` } }).solicitud_llm.messages[0].content;
  assert.match(sistemaLucia, /Javier trabaja la propiedad en exclusiva con una comisión del 5 %/, 'propuesta aprobada');
  assert.match(sistemaLucia, /No inventes la base de cálculo/);
  assert.doesNotMatch(sistemaLucia, /\{\{/);
  assert.match(sistema, /Sin emojis/);
  assert.doesNotMatch(sistema, /\{\{/, 'sin marcadores sin reemplazar');
});

test('no calificado: con nutrición activa recibe mensaje cordial y dossier una sola vez', () => {
  const plantillas = { ...ctxBase().plantillas, no_calificado_nutricion: 'Quedas registrado.' };
  const tenant = { ...ctxBase().tenant, parametros: { nutricion: { incluir_no_calificados: true }, dossier: { lucia: { url: 'https://x.co/d.pdf' } } } };
  const primera = conv.planificarRespuesta(ctxBase({ plantillas, tenant, evaluacion: { accion: 'archivar' }, estado_anterior: 'informacion_incompleta' }));
  assert.equal(primera.respuesta_fija.plantilla, 'no_calificado_nutricion');
  assert.equal(primera.respuesta_fija.documento.url, 'https://x.co/d.pdf');
  assert.equal(conv.planificarRespuesta(ctxBase({ plantillas, tenant, evaluacion: { accion: 'archivar' }, estado_anterior: 'no_calificado' })).respuesta_fija, null);

  const sinNutricion = conv.planificarRespuesta(ctxBase({ plantillas, evaluacion: { accion: 'archivar' } }));
  assert.equal(sinNutricion.respuesta_fija.plantilla, 'no_calificado');
  assert.equal(sinNutricion.respuesta_fija.documento, undefined);
});

// --- Retorno tras días sin contacto --------------------------------------------------

const RETORNO = { horas_sin_contacto: 75, ultimo_contacto_en: '2026-10-13T12:00:00Z', ahora: '2026-10-16T15:00:00Z' };

function promptRetorno(extra) {
  const plan = conv.planificarRespuesta(ctxBase({
    retorno: RETORNO,
    evaluacion: { accion: 'ofrecer_agenda', campos_faltantes: [] },
    ...extra,
  }));
  assert.equal(plan.respuesta_fija, null, 'quien regresa recibe un saludo redactado, no una plantilla');
  return plan.solicitud_llm.messages[0].content;
}

test('retorno: saluda por el nombre, recuerda la cita vigente y pregunta en qué ayudar', () => {
  const prompt = promptRetorno({
    conversacion: { ...ctxBase().conversacion, identificado_como_virtual: false },
    contacto: { ...ctxBase().contacto, estado: 'cita_confirmada', datos: { nombre: 'Rafael' } },
    cita: { estado: 'confirmada', inicio: '2026-10-19T13:00:00Z', modalidad: 'llamada' },
    tenant: { ...ctxBase().tenant, parametros: { comercial: { asesor: 'Javier' } } },
  });
  assert.match(prompt, /Dirígete a la persona como "Rafael"/);
  assert.match(prompt, /después de 3 días sin contacto/);
  assert.match(prompt, /tiene una reunión con Javier el lunes, 19 de octubre, 8:00 a\. m\./);
  assert.match(prompt, /en qué la puedes ayudar hoy/);
  assert.match(prompt, /Preséntate en pocas palabras como/);
  assert.doesNotMatch(prompt, /Hola, soy Lucía\./, 'no repite la presentación con preguntas de inicio');
});

test('retorno: tema abierto según el estado, y nada que retomar si no calificó', () => {
  const tema = (contacto, extra = {}) => conv.temaAbierto(ctxBase({ retorno: RETORNO, contacto: { ...ctxBase().contacto, ...contacto }, ...extra }));
  assert.equal(tema({ estado: 'calificado_pendiente_agendamiento' }), 'quedó pendiente agendar la reunión con un asesor');
  assert.equal(tema({ estado: 'nutricion', datos: { plazo_meses: 8 } }), 'nos contó que pensaba concretar en unos 8 meses');
  assert.equal(tema({ estado: 'informacion_incompleta', datos: { nombre: 'Ana', ciudad: 'Bogotá' } }), 'quedaron pendientes unos datos de su propiedad');
  assert.equal(tema({ estado: 'no_calificado' }), null);
  // Cita que ya pasó: no hay nada que recordar.
  assert.equal(tema({ estado: 'cita_confirmada' }, { cita: { estado: 'confirmada', inicio: '2026-10-14T13:00:00Z' } }), null);
  assert.match(promptRetorno({ contacto: { ...ctxBase().contacto, estado: 'no_calificado' } }), /no menciones detalles de la conversación anterior/);
});

test('agenda: no ofrece horarios a quien regresa ni a quien ya tiene una cita vigente', () => {
  const agenda = require('../src/n8n/agenda');
  const base = ctxBase({ evaluacion: { accion: 'ofrecer_agenda' }, conversacion: { ...ctxBase().conversacion, agenda: {} } });
  assert.deepEqual(agenda.planificarAgenda(base, null), { paso: 'ofrecer' });
  assert.deepEqual(agenda.planificarAgenda({ ...base, retorno: RETORNO }, null), { paso: null });
  // El caso real del 15 oct: estado no_calificado pero con cita confirmada a futuro.
  const conCita = { ...base, contacto: { ...base.contacto, estado: 'no_calificado' }, cita: { estado: 'confirmada', inicio: '2030-10-19T13:00:00Z' } };
  assert.deepEqual(agenda.planificarAgenda(conCita, null), { paso: null });
  // Una cita que ya pasó no impide agendar otra.
  assert.deepEqual(agenda.planificarAgenda({ ...conCita, cita: { estado: 'confirmada', inicio: '2020-01-01T13:00:00Z' } }, null), { paso: 'ofrecer' });
});

// --- Otra propiedad (oportunidades) ---------------------------------------------------

test('otra propiedad: el extractor la detecta solo si ya hay una registrada', () => {
  const sin = conv.solicitudExtraccion(ctxBase());
  assert.doesNotMatch(sin.messages[0].content, /nueva_propiedad": true/);
  const con = conv.solicitudExtraccion(ctxBase({
    contacto: { ...ctxBase().contacto, estado: 'cita_confirmada', datos: { nombre: 'Rafael', ciudad: 'Bogotá', direccion: 'Cra 17A #106-50' } },
  }));
  assert.match(con.messages[0].content, /OTRA propiedad distinta/);
  assert.match(con.messages[0].content, /"misma_cita": true/);
  const r = conv.interpretarExtraccion(openaiOk('{"datos":{"ciudad":"Bogotá"},"nueva_propiedad":true,"misma_cita":"si"}'));
  assert.equal(r.nueva_propiedad, true);
  assert.equal(r.misma_cita, false, 'solo un booleano true cuenta');
});

test('otra propiedad en la misma reunión: no ofrece horarios, deja nota y lo confirma', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const compartida = { id: 'ci1', inicio: '2030-10-21T13:00:00Z', estado: 'confirmada', modalidad: 'llamada' };
  const ctx = ctxBase({
    contacto: { ...ctxBase().contacto, estado: 'cita_confirmada', ghl_contact_id: 'g1', datos: { nombre: 'Rafael', ciudad: 'Bogotá', direccion: 'Cra 15A #106-50' } },
    rol: { ...ctxBase().rol, nombre_visible: 'Lucía' },
    oportunidad: { id: 'o2', anteriores: 1, nota_asesor_en: null, cita_compartida: compartida },
    evaluacion: { resultado: 'calificado', accion: 'ofrecer_agenda', campos_faltantes: [] },
    tenant: { ...ctxBase().tenant, parametros: { comercial: { asesor: 'Javier' } } },
    conversacion: { ...ctxBase().conversacion, identificado_como_virtual: true, agenda: {} },
  });
  assert.deepEqual(agenda.planificarAgenda(ctx, null), { paso: 'nota' });
  assert.deepEqual(agenda.planificarAgenda({ ...ctx, oportunidad: { ...ctx.oportunidad, nota_asesor_en: '2030-01-01' } }, null), { paso: null });
  assert.deepEqual(agenda.planificarAgenda({ ...ctx, evaluacion: { resultado: 'informacion_incompleta', accion: 'solicitar_datos' } }, null), { paso: null });

  const nota = agenda.solicitudNota(ctx, ghl);
  assert.equal(nota.error, null);
  assert.equal(nota.solicitud.url, 'https://services.leadconnectorhq.com/contacts/g1/notes');
  assert.match(nota.solicitud.cuerpo.body, /Lucía: propiedad adicional para revisar en la reunión del lunes 21 de octubre/);
  assert.match(nota.solicitud.cuerpo.body, /Cra 15A #106-50/);
  assert.deepEqual(agenda.interpretarNota({ statusCode: 201, body: { note: { id: 'n1' } } }, nota, ghl), { ok: true, error: null });
  assert.equal(agenda.interpretarNota({ statusCode: 401, body: {} }, nota, ghl).error.motivo, 'credencial_invalida');

  const prompt = conv.planificarRespuesta(ctx).solicitud_llm.messages[0].content;
  assert.match(prompt, /se revisará en la reunión que la persona ya tiene agendada con Javier/);
  assert.match(prompt, /no los mezcles con lo hablado antes/);
});

test('otra propiedad en la misma reunión con prioridad baja: no se nutre', () => {
  const ctx = ctxBase({
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Ana Gómez', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, tipo_inmueble: 'casa', ciudad: 'Bogotá', barrio: 'Usaquén', direccion: 'Cl 1 # 2-3', relacion_inmueble: 'propietario', intencion_venta: true, plazo_meses: 12 } },
    verificacion: { resultado: 'verificada' },
    tenant: { ...ctxBase().tenant, parametros: require('../config/tenants/javier-nunez/tenant.json').parametros },
  });
  assert.equal(conv.evaluarTurno(ctx, evaluarCalificacion).evaluacion.accion, 'nutrir');
  const compartida = conv.evaluarTurno({ ...ctx, oportunidad: { cita_compartida: { inicio: '2030-01-01T13:00:00Z' } } }, evaluarCalificacion);
  assert.equal(compartida.evaluacion.accion, 'ofrecer_agenda');
});

test('flujo: la nota para el asesor pasa por la BD y vuelve a la respuesta', async () => {
  const sig = (n, i = 0) => flujo.connections[n].main[i].map((d) => d.node);
  assert.deepEqual(sig('¿Agendar ahora?'), ['¿Nota para el asesor?']);
  assert.deepEqual(sig('¿Nota para el asesor?', 0), ['Preparar nota GHL']);
  assert.deepEqual(sig('¿Nota para el asesor?', 1), ['¿Reservar?']);
  assert.deepEqual(sig('Registrar nota'), ['Planificar respuesta']);
  assert.equal(flujo.nodes.find((n) => n.name === 'GHL: nota para el asesor').retryOnFail, false, 'la nota no se duplica');

  const r = ctxBase({ evaluacion: { resultado: 'calificado', accion: 'ofrecer_agenda' } });
  const previo = { r, solicitud: { url: 'u' }, error: null };
  const salida = await ejecutarCode('Interpretar nota', { statusCode: 201, body: { note: { id: 'n1' } } }, { 'Preparar nota GHL': previo });
  const payload = JSON.parse(Buffer.from(salida.json.payload_b64, 'base64').toString());
  assert.deepEqual(payload, { ok: true, error: null, evaluacion: r.evaluacion });
});

// --- Correcciones de la reunión de revisión (Lucía) -----------------------------------

const PARAMS = require('../config/tenants/javier-nunez/tenant.json').parametros;
const luciaReal = require('../config/tenants/javier-nunez/roles/lucia.json');

function ctxLucia(extra = {}) {
  const base = ctxBase({ tenant: { ...ctxBase().tenant, parametros: PARAMS } });
  return { ...base, ...extra, rol: { ...base.rol, campos: luciaReal.campos, criterios: luciaReal.criterios, nombre_visible: 'Lucía', ...(extra.rol || {}) } };
}
const sistemaDe = (plan) => plan.solicitud_llm.messages[0].content;

test('Lucía: si no tiene tiempo, se respeta y no pregunta', () => {
  const plan = conv.planificarRespuesta(ctxLucia({
    contacto: { ...ctxBase().contacto, datos: { acepta_preguntas: false } },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['ciudad'] },
  }));
  assert.match(sistemaDe(plan), /no tiene tiempo: respétalo/);
  assert.doesNotMatch(sistemaDe(plan), /Pide solo el siguiente dato/);
});

test('Lucía: con solo el primer nombre pide el nombre completo y no califica', () => {
  const datos = { nombre: 'Rafael', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
    tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', intencion_venta: true, plazo_meses: 2, acepta_preguntas: true };
  const ctx = ctxLucia({ contacto: { ...ctxBase().contacto, datos }, verificacion: { resultado: 'verificada' } });
  const ev = conv.evaluarTurno(ctx, evaluarCalificacion).evaluacion;
  assert.equal(ev.resultado, 'informacion_incompleta');
  assert.deepEqual(ev.campos_faltantes, ['nombre']);
  assert.match(sistemaDe(conv.planificarRespuesta({ ...ctx, evaluacion: ev })), /¿Me puedes facilitar tu nombre completo, por favor\?/);
});

test('Lucía: antes de agendar presenta la propuesta y espera que quiera continuar', () => {
  const datos = { nombre: 'Rafael Rivas', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
    tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', intencion_venta: true, plazo_meses: 2, acepta_preguntas: true };
  const ctx = ctxLucia({ contacto: { ...ctxBase().contacto, datos }, verificacion: { resultado: 'verificada' } });
  const ev = conv.evaluarTurno(ctx, evaluarCalificacion).evaluacion;
  assert.equal(ev.resultado, 'calificado');
  assert.equal(ev.accion, 'presentar_propuesta');
  const agenda = require('../src/n8n/agenda');
  assert.deepEqual(agenda.planificarAgenda({ ...ctx, evaluacion: ev, conversacion: { ...ctx.conversacion, agenda: {} } }, null), { paso: null }, 'sin horarios todavía');
  const prompt = sistemaDe(conv.planificarRespuesta({ ...ctx, evaluacion: ev }));
  assert.match(prompt, /Javier trabaja la propiedad en exclusiva con una comisión del 5 %/);
  assert.match(prompt, /¿Hay algún punto que quieras aclarar antes de continuar\?/);
  assert.match(prompt, /No garantices precio ni plazo/);

  const sigue = { ...ctx, contacto: { ...ctx.contacto, datos: { ...datos, desea_continuar: true } } };
  assert.equal(conv.evaluarTurno(sigue, evaluarCalificacion).evaluacion.accion, 'ofrecer_agenda', 'quiere continuar: se ofrecen horarios');
  const noSigue = { ...ctx, contacto: { ...ctx.contacto, datos: { ...datos, desea_continuar: false } } };
  const evNo = conv.evaluarTurno(noSigue, evaluarCalificacion).evaluacion;
  assert.match(sistemaDe(conv.planificarRespuesta({ ...noSigue, evaluacion: evNo })), /prefirió no avanzar por ahora/);
});

test('Lucía: fuera de cobertura pide autorización para una posible referencia, sin prometer', () => {
  const ctx = ctxLucia({
    plantillas: { ...ctxBase().plantillas, fuera_cobertura: require('../config/tenants/javier-nunez/plantillas.json').find((p) => p.clave === 'fuera_cobertura').texto },
    evaluacion: { resultado: 'no_calificado', accion: 'archivar', codigo_motivo: 'cobertura_ciudad' },
    estado_anterior: 'informacion_incompleta',
  });
  const plan = conv.planificarRespuesta(ctx);
  assert.equal(plan.respuesta_fija.plantilla, 'fuera_cobertura');
  assert.match(plan.respuesta_fija.texto, /Javier atiende directamente propiedades en Bogotá\. .*¿Nos autorizas a compartir/);

  const despues = (autoriza) => sistemaDe(conv.planificarRespuesta({
    ...ctx, estado_anterior: 'no_calificado', contacto: { ...ctx.contacto, estado: 'no_calificado', datos: { autoriza_referencia: autoriza } },
  }));
  assert.match(despues(true), /si encuentran una opción, podrán gestionar la referencia/);
  assert.match(despues(false), /no se compartirán/);
  assert.match(despues(undefined), /autoriza compartir sus datos/);
  for (const a of [true, false, undefined]) {
    assert.match(despues(a), /no digas que hay un agente disponible ni que alguien la contactará/);
    assert.match(despues(a), /necesita alguna aclaración/);
  }
});

test('agenda: no ofrece horarios antes de las 9:00 a. m. (hora de Bogotá)', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const ctx = ctxLucia({ integraciones: { calendario: { horarios_a_ofrecer: 4, horarios_por_dia: 4, antelacion_minima_minutos: 0 } } });
  const body = { '2030-10-21': { slots: ['2030-10-21T08:00:00-05:00', '2030-10-21T09:00:00-05:00', '2030-10-21T23:00:00-05:00'] } };
  const r = agenda.interpretarHorarios({ statusCode: 200, body }, ctx, ghl, new Date('2030-10-20T00:00:00Z'));
  assert.deepEqual(r.ofrecidos, ['2030-10-21T09:00:00-05:00'], 'cierre a las 9:00 p. m.: no ofrece las 11:00 p. m.');
  const conTarde = { '2030-10-21': { slots: ['2030-10-21T20:00:00-05:00', '2030-10-21T20:30:00-05:00', '2030-10-21T21:00:00-05:00'] } };
  const ofrecidos = (c) => agenda.interpretarHorarios({ statusCode: 200, body: conTarde }, c, ghl, new Date('2030-10-20T00:00:00Z')).ofrecidos;
  assert.deepEqual(ofrecidos(ctx), ['2030-10-21T20:00:00-05:00', '2030-10-21T20:30:00-05:00'], 'sin duración: debe empezar antes del cierre');
  const conDuracion = { ...ctx, integraciones: { calendario: { ...ctx.integraciones.calendario, duracion_minutos: 60 } } };
  assert.deepEqual(ofrecidos(conDuracion), ['2030-10-21T20:00:00-05:00'], 'con duración: debe terminar a la hora de cierre');
});

test('agenda: la cita lleva para Javier el origen, la prioridad y las dudas', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const ctx = ctxLucia({
    contacto: { ...ctxBase().contacto, ghl_contact_id: 'g1', canal_origen: 'whatsapp', datos: { nombre: 'Rafael Rivas', acepta_preguntas: true, dudas_propuesta: 'Duración de la exclusividad', desea_continuar: true } },
    conversacion: { ...ctxBase().conversacion, agenda: { ofrecidos: ['2030-10-21T09:00:00-05:00'] } },
    integraciones: { calendario: { calendar_id: 'cal', location_id: 'loc', modalidades: { llamada: 'phone' } } },
    evaluacion: { resultado: 'calificado', prioridad: 'alta' },
  });
  const desc = agenda.solicitudReserva(ctx, { inicio: '2030-10-21T09:00:00-05:00', modalidad: 'llamada' }, ghl).solicitud.cuerpo.description;
  assert.match(desc, /^Origen: WhatsApp\nPrioridad: alta\n/);
  assert.match(desc, /Dudas sobre la propuesta: Duración de la exclusividad/);
  assert.match(desc, /Quiere avanzar con Javier: sí/);
  assert.doesNotMatch(desc, /Aceptó responder/);
});

test('cambio de asistente: el extractor lo detecta y la nueva se presenta', () => {
  assert.match(conv.solicitudExtraccion(ctxLucia()).messages[0].content, /"cambio_intencion": "comprar"/);
  assert.equal(conv.interpretarExtraccion(openaiOk('{"datos":{},"cambio_intencion":"comprar"}')).cambio_intencion, 'comprar');
  assert.equal(conv.interpretarExtraccion(openaiOk('{"datos":{},"cambio_intencion":"otro"}')).cambio_intencion, null);
  const sonia = ctxLucia({
    rol: { codigo: 'sonia', nombre_visible: 'Sonia', campos: [], criterios: { campos_obligatorios: [], reglas: [] } },
    oportunidad: { id: 'o2', anteriores: 1, rol_anterior: 'lucia' },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: [] },
  });
  assert.match(sistemaDe(conv.planificarRespuesta(sonia)), /preséntate en una frase como Sonia, asistente virtual de Javier Núñez del Toro/);
});

// --- Conciliación de reservas (AC 40) ------------------------------------------------

test('reserva: reutiliza la cita que GoHighLevel ya creó en ese horario (hora sin zona)', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const ctx = ctxBase({ integraciones: { calendario: { calendar_id: 'cal' } }, citas_externas: ['YA-REGISTRADA'] });
  const plan = { inicio: '2026-10-19T09:00:00-05:00', modalidad: 'llamada' };
  const lista = (eventos) => ({ statusCode: 200, body: { events: eventos } });
  const ev = (extra) => ({ id: 'G1', calendarId: 'cal', startTime: '2026-10-19 09:00:00', appointmentStatus: 'booked', assignedUserId: 'U1', ...extra });

  const existente = agenda.citaYaCreada(lista([ev()]), ctx, plan, ghl);
  assert.equal(existente.body.id, 'G1', 'la hora sin zona se lee en la zona del calendario');
  const reserva = agenda.interpretarReserva(existente, ctx, plan, {}, ghl);
  assert.equal(reserva.resultado.confirmada, true);
  assert.equal(reserva.resultado.id_externo, 'G1');
  assert.equal(reserva.hora_texto, '9:00 a. m.');

  assert.equal(agenda.citaYaCreada(lista([ev({ startTime: '2026-10-19 10:00:00' })]), ctx, plan, ghl), null, 'otro horario: se crea');
  assert.equal(agenda.citaYaCreada(lista([ev({ appointmentStatus: 'cancelled' })]), ctx, plan, ghl), null, 'cancelada: se crea');
  assert.equal(agenda.citaYaCreada(lista([ev({ calendarId: 'otro' })]), ctx, plan, ghl), null, 'otro calendario: se crea');
  assert.equal(agenda.citaYaCreada(lista([ev({ id: 'YA-REGISTRADA' })]), ctx, plan, ghl), null, 'ya registrada (otra propiedad): se crea');
  assert.ok(agenda.citaYaCreada(lista([ev({ startTime: '2026-10-19T14:00:00Z' })]), ctx, plan, ghl), 'también acepta ISO con zona');
  assert.equal(agenda.citaYaCreada({ statusCode: 401, body: {} }, ctx, plan, ghl), null, 'si la consulta falla, se crea como siempre');
  assert.equal(agenda.citaYaCreada({ error: 'timeout' }, ctx, plan, ghl), null);
});

test('flujo: antes de crear la cita consulta las del contacto', async () => {
  const sig = (n, i = 0) => flujo.connections[n].main[i].map((d) => d.node);
  assert.deepEqual(sig('Preparar reserva'), ['Preparar consulta de citas']);
  assert.deepEqual(sig('GHL: citas del contacto'), ['Buscar cita existente']);
  assert.deepEqual(sig('¿Cita ya creada?', 0), ['Interpretar reserva']);
  assert.deepEqual(sig('¿Cita ya creada?', 1), ['GHL: crear cita']);

  const r = ctxBase({ integraciones: { calendario: { calendar_id: 'cal' } }, citas_externas: [] });
  const previo = { r, plan: { inicio: '2026-10-19T09:00:00-05:00', modalidad: 'llamada' }, solicitud: { url: 'crear' }, error: null };
  const respuesta = { statusCode: 200, body: { events: [{ id: 'G1', calendarId: 'cal', startTime: '2026-10-19 09:00:00', appointmentStatus: 'booked' }] } };
  const buscada = await ejecutarCode('Buscar cita existente', respuesta, { 'Preparar reserva': previo });
  assert.equal(buscada.json.existente.body.id, 'G1');
  assert.deepEqual(buscada.json.solicitud, { url: 'crear' }, 'conserva la solicitud de crear para la otra rama');
  const interpretada = await ejecutarCode('Interpretar reserva', buscada.json, { 'Preparar reserva': previo });
  assert.equal(decodificar(interpretada.json.payload_b64).resultado.id_externo, 'G1');
});

test('extracción: con casos anteriores lee solo los mensajes del caso actual', () => {
  const m = (direccion, contenido, creado_en) => ({ direccion, remitente: direccion === 'entrante' ? 'contacto' : 'agente', contenido, creado_en });
  const historial = [
    m('entrante', 'Mi casa está en el barrio Riomar', '2026-10-17T16:00:00Z'),
    m('saliente', '¿En cuánto tiempo quieres vender?', '2026-10-17T16:01:00Z'),
    m('entrante', 'Quiero vender otra propiedad', '2026-10-17T16:41:00Z'),
    m('saliente', '¿Qué tipo de inmueble es?', '2026-10-17T16:41:10Z'),
    m('entrante', 'Un apartamento', '2026-10-17T16:42:00Z'),
  ];
  const ctx = ctxBase({ historial, oportunidad: { id: 'o3', anteriores: 2, creada_en: '2026-10-17T16:41:04Z' } });
  const textos = conv.solicitudExtraccion(ctx).messages.slice(1).map((x) => x.content);
  assert.deepEqual(textos, ['¿Qué tipo de inmueble es?', 'Un apartamento'], 'sin el barrio de la propiedad anterior');
  const primera = conv.solicitudExtraccion(ctxBase({ historial, oportunidad: { id: 'o1', anteriores: 0, creada_en: '2026-10-17T16:41:04Z' } }));
  assert.equal(primera.messages.length, historial.length + 1, 'sin casos anteriores lee todo');
  const recien = conv.solicitudExtraccion(ctxBase({ historial, oportunidad: { id: 'o4', anteriores: 3, creada_en: '2026-10-17T17:00:00Z' } }));
  assert.equal(recien.messages.length, 3, 'caso recién creado: al menos la última pregunta y respuesta');
});

test('dirección imprecisa: la plantilla una vez; luego aclaración con la sugerencia de Google', () => {
  const ctx = (ultimo) => ctxBase({
    evaluacion: { accion: 'aclarar_direccion', campos_faltantes: [] },
    verificacion: { resultado: 'ambigua', direccion_normalizada: 'Cra 15 #4BIS-46, Bogotá, Colombia' },
    historial: [{ direccion: 'saliente', contenido: ultimo }, { direccion: 'entrante', contenido: '¿A qué hora se van?' }],
  });
  assert.equal(conv.planificarRespuesta(ctx('¿En cuánto tiempo?')).respuesta_fija.plantilla, 'direccion_ambigua');
  const segunda = conv.planificarRespuesta(ctx('Dirección ambigua.'));
  assert.equal(segunda.respuesta_fija, null, 'no repite la plantilla');
  const prompt = segunda.solicitud_llm.messages[0].content;
  assert.match(prompt, /Google encontró "Cra 15 #4BIS-46, Bogotá, Colombia"/);
  assert.match(prompt, /no repitas ese mensaje/);
});
