'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const meta = require('../src/n8n/meta');
const geo = require('../src/n8n/geocodificacion');
const conv = require('../src/n8n/conversacion');
const { evaluarCalificacion } = require('../src/calificacion/evaluar');
const { flujo, flujoReporte, flujoBarrios, EXPRESION_TRAE_MENSAJES } = require('../scripts/generar-n8n');
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
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Ana"}}')), { datos: { nombre: 'Ana' }, seleccion: null, nueva_propiedad: false, misma_cita: false, cambio_intencion: null, preferencia_horario: null, eventos: [] });
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
      tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', estado_ocupacion: 'desocupado', publicado_en_mercado: 'no', otros_decisores: 'nadie más', intencion_venta: true, plazo_meses: 12 } },
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
  assert.match(sistema, /con exclusividad la promoción es más concentrada/);
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

test('otra propiedad en la misma reunión con prioridad baja: va a esa reunión', () => {
  const ctx = ctxBase({
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Ana Gómez', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, tipo_inmueble: 'casa', ciudad: 'Bogotá', barrio: 'Usaquén', direccion: 'Cl 1 # 2-3', relacion_inmueble: 'propietario', estado_ocupacion: 'desocupado', publicado_en_mercado: 'no', otros_decisores: 'nadie más', intencion_venta: true, plazo_meses: 12 } },
    verificacion: { resultado: 'verificada' },
    tenant: { ...ctxBase().tenant, parametros: require('../config/tenants/javier-nunez/tenant.json').parametros },
  });
  const sola = conv.evaluarTurno(ctx, evaluarCalificacion).evaluacion;
  assert.equal(sola.prioridad, 'baja');
  assert.equal(sola.agendar_desde_dias, 14, 'prioridad B: se agenda a futuro');
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
// Agenda sin el cronograma de Javier: solo días, hora mínima y máxima (respaldo).
const { ventanas_llamada, viernes_rotacion, excepciones, vacaciones, ...AGENDA_BASICA } = PARAMS.agenda;
const PARAMS_BASICOS = { ...PARAMS, agenda: { ...AGENDA_BASICA, dias_semana: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'] } };
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
    tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', estado_ocupacion: 'desocupado', publicado_en_mercado: 'no', otros_decisores: 'nadie más', intencion_venta: true, plazo_meses: 2, acepta_preguntas: true };
  const ctx = ctxLucia({ contacto: { ...ctxBase().contacto, datos }, verificacion: { resultado: 'verificada' } });
  const ev = conv.evaluarTurno(ctx, evaluarCalificacion).evaluacion;
  assert.equal(ev.resultado, 'informacion_incompleta');
  assert.deepEqual(ev.campos_faltantes, ['nombre']);
  assert.match(sistemaDe(conv.planificarRespuesta({ ...ctx, evaluacion: ev })), /¿Me puedes facilitar tu nombre completo, por favor\?/);
});

test('Lucía: antes de agendar presenta la propuesta y espera que quiera continuar', () => {
  const datos = { nombre: 'Rafael Rivas', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
    tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', estado_ocupacion: 'desocupado', publicado_en_mercado: 'no', otros_decisores: 'nadie más', intencion_venta: true, plazo_meses: 2, acepta_preguntas: true };
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
  assert.match(plan.respuesta_fija.texto, /Javier atiende directamente propiedades en Bogotá.*¿Nos autorizas a compartir/);
  assert.doesNotMatch(plan.respuesta_fija.texto, /se comunicará|te contactará|te llamará/, 'no promete contacto');

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
  const ctx = ctxLucia({ tenant: { ...ctxBase().tenant, parametros: PARAMS_BASICOS }, integraciones: { calendario: { horarios_a_ofrecer: 4, horarios_por_dia: 4, antelacion_minima_minutos: 0 } } });
  const body = { '2030-10-21': { slots: ['2030-10-21T08:00:00-05:00', '2030-10-21T09:00:00-05:00', '2030-10-21T18:00:00-05:00'] } };
  const r = agenda.interpretarHorarios({ statusCode: 200, body }, ctx, ghl, new Date('2030-10-20T00:00:00Z'));
  assert.deepEqual(r.ofrecidos, ['2030-10-21T09:00:00-05:00'], 'cierre a las 5:00 p. m.: no ofrece las 6:00 p. m.');
  const conTarde = { '2030-10-21': { slots: ['2030-10-21T16:00:00-05:00', '2030-10-21T16:30:00-05:00', '2030-10-21T17:00:00-05:00'] } };
  const ofrecidos = (c, b = conTarde) => agenda.interpretarHorarios({ statusCode: 200, body: b }, c, ghl, new Date('2030-10-20T00:00:00Z')).ofrecidos;
  assert.deepEqual(ofrecidos(ctx), ['2030-10-21T16:00:00-05:00', '2030-10-21T16:30:00-05:00'], 'sin duración: debe empezar antes del cierre');
  const conDuracion = { ...ctx, integraciones: { calendario: { ...ctx.integraciones.calendario, duracion_minutos: 60 } } };
  assert.deepEqual(ofrecidos(conDuracion), ['2030-10-21T16:00:00-05:00'], 'con duración: debe terminar a la hora de cierre');

  // Lunes a viernes (parametros.agenda.dias_semana, 27 oct 2026): sábado 26 y domingo 27 no se ofrecen.
  const semana = { '2030-10-25': { slots: ['2030-10-25T10:00:00-05:00'] }, '2030-10-26': { slots: ['2030-10-26T10:00:00-05:00'] }, '2030-10-27': { slots: ['2030-10-27T10:00:00-05:00'] } };
  assert.deepEqual(ofrecidos(ctx, semana), ['2030-10-25T10:00:00-05:00'], 'solo el viernes');
  const todos = { ...ctx, tenant: { ...ctx.tenant, parametros: { ...PARAMS_BASICOS, agenda: { ...PARAMS_BASICOS.agenda, dias_semana: undefined } } } };
  assert.equal(ofrecidos(todos, semana).length, 3, 'sin dias_semana se aceptan todos los días');
});

test('agenda: las franjas del extractor salen de los parámetros', () => {
  const ctx = ctxLucia({ contacto: { ...ctxBase().contacto, estado: 'calificado_pendiente_agendamiento' } });
  const sistema = conv.solicitudExtraccion(ctx).messages[0].content;
  assert.match(sistema, /"En la mañana" = desde 09:00 hasta 12:00; "En la tarde" = desde 12:00 hasta 17:00\./);
  assert.doesNotMatch(sistema, /En la noche/, 'sin franja de noche: se atiende hasta las 5:00 p. m.');
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

test('propuesta: texto fijo aprobado la primera vez; después el agente responde dudas', () => {
  const plantilla = require('../config/tenants/javier-nunez/plantillas.json').find((p) => p.clave === 'propuesta').texto;
  const datos = { nombre: 'Rafael Rivas', telefono: '+573001112233', operacion: 'venta', valor_estimado_cop: 450000000, ciudad: 'Bogotá', barrio: 'Chapinero', direccion: 'Cl 63 # 9-15',
    tipo_inmueble: 'apartamento', relacion_inmueble: 'propietario', estado_ocupacion: 'desocupado', publicado_en_mercado: 'no', otros_decisores: 'nadie más', intencion_venta: true, plazo_meses: 2, acepta_preguntas: true };
  const base = ctxLucia({ contacto: { ...ctxBase().contacto, datos }, verificacion: { resultado: 'verificada' }, plantillas: { ...ctxBase().plantillas, propuesta: plantilla } });
  const ev = conv.evaluarTurno(base, evaluarCalificacion).evaluacion;
  const plan = conv.planificarRespuesta({ ...base, evaluacion: ev });
  assert.equal(plan.respuesta_fija.texto,
    'Perfecto, Rafael. Ya tenemos toda la información. Antes de avanzar con la llamada con Javier, queremos comentarte que Javier trabaja las propiedades en exclusiva y con una comisión del 5 %. No garantizamos el precio ni el plazo de venta. ¿Hay algo que quieras aclarar antes de continuar?');
  assert.doesNotMatch(plan.respuesta_fija.texto, /beneficios aprobados/);

  const conHistorial = { ...base, evaluacion: ev, historial: [{ direccion: 'saliente', contenido: plan.respuesta_fija.texto }, { direccion: 'entrante', contenido: '¿La exclusividad cuánto dura?' }] };
  const despues = conv.planificarRespuesta(conHistorial);
  assert.equal(despues.respuesta_fija, null, 'no se repite');
  assert.match(sistemaDe(despues), /No menciones beneficios que no estén en la propuesta/);
  assert.doesNotMatch(sistemaDe(despues), /No hay otros beneficios aprobados/);

  const sinNombre = conv.planificarRespuesta({ ...base, contacto: { ...base.contacto, nombre: null, datos: { ...datos, nombre: undefined } }, evaluacion: ev });
  assert.match(sinNombre.respuesta_fija.texto, /^Perfecto\. Ya tenemos toda la información\./);
});

test('agenda: no ofrece horarios que ya tienen una cita registrada', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const body = { '2030-10-21': { slots: ['2030-10-21T09:00:00-05:00', '2030-10-21T10:00:00-05:00', '2030-10-21T11:00:00-05:00'] } };
  const ctx = ctxLucia({
    integraciones: { calendario: { horarios_a_ofrecer: 4, horarios_por_dia: 4, antelacion_minima_minutos: 0 } },
    horarios_ocupados: ['2030-10-21T14:00:00+00:00'],
  });
  const ofrecidos = (c) => agenda.interpretarHorarios({ statusCode: 200, body }, c, ghl, new Date('2030-10-20T00:00:00Z')).ofrecidos;
  assert.deepEqual(ofrecidos(ctx), ['2030-10-21T10:00:00-05:00', '2030-10-21T11:00:00-05:00'], 'las 9:00 ya tienen cita');
  const conDuracion = { ...ctx, integraciones: { calendario: { ...ctx.integraciones.calendario, duracion_minutos: 90 } } };
  assert.deepEqual(ofrecidos(conDuracion), ['2030-10-21T11:00:00-05:00'], 'con 90 minutos, las 10:00 se cruzan');
});

test('agenda: si eligen un horario que se ocupó después de ofrecerlo, se ofrecen otros', () => {
  const agenda = require('../src/n8n/agenda');
  const ctx = ctxLucia({
    evaluacion: { accion: 'ofrecer_agenda' },
    conversacion: { ...ctxBase().conversacion, agenda: { ofrecidos: ['2030-10-21T09:00:00-05:00', '2030-10-22T09:00:00-05:00'] } },
    horarios_ocupados: ['2030-10-21T14:00:00.000Z'],
  });
  assert.deepEqual(agenda.planificarAgenda(ctx, { horario: 1 }), { paso: 'ofrecer' });
  assert.equal(agenda.planificarAgenda(ctx, { horario: 2 }).paso, 'reservar');
});

test('propuesta: se presenta en cada caso aunque ya se haya enviado para otra propiedad', () => {
  const plantilla = require('../config/tenants/javier-nunez/plantillas.json').find((p) => p.clave === 'propuesta').texto;
  const texto = plantilla.replace('{{nombre}}', 'Rafael').replace(/\{\{asesor\}\}/g, 'Javier').replace('{{comision_pct}}', '5');
  const ctx = ctxLucia({
    plantillas: { ...ctxBase().plantillas, propuesta: plantilla },
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Rafael Rivas' } },
    evaluacion: { resultado: 'calificado', accion: 'presentar_propuesta' },
    oportunidad: { id: 'o3', anteriores: 2, creada_en: '2026-10-17T23:07:00Z' },
    historial: [
      { direccion: 'saliente', contenido: texto, creado_en: '2026-10-17T22:03:00Z' },
      { direccion: 'entrante', contenido: 'Quiero vender otra propiedad', creado_en: '2026-10-17T23:07:00Z' },
    ],
  });
  assert.equal(conv.planificarRespuesta(ctx).respuesta_fija.texto, texto, 'la del caso anterior no cuenta');
  const yaEnEste = { ...ctx, historial: [...ctx.historial, { direccion: 'saliente', contenido: texto, creado_en: '2026-10-17T23:11:00Z' }] };
  assert.equal(conv.planificarRespuesta(yaEnEste).respuesta_fija, null);
  const comun = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'prompts', 'comun.md'), 'utf8');
  const conReglas = { ...yaEnEste, rol: { ...yaEnEste.rol, prompt_sistema: comun } };
  assert.match(sistemaDe(conv.planificarRespuesta(conReglas)), /El encuentro con Javier es una \*\*llamada telefónica\*\*: es lo que ofreces siempre/);
});

test('extracción: no reemplaza el nombre completo por solo el primer nombre', () => {
  const ctx = ctxBase({ contacto: { ...ctxBase().contacto, datos: { nombre: 'Rafael Rivas' } } });
  assert.deepEqual(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Rafael","ciudad":"Bogotá"}}'), ctx).datos, { ciudad: 'Bogotá' });
  assert.equal(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Rafael José Rivas"}}'), ctx).datos.nombre, 'Rafael José Rivas', 'uno más completo sí');
  assert.equal(conv.interpretarExtraccion(openaiOk('{"datos":{"nombre":"Ana Gómez"}}'), ctx).datos.nombre, 'Ana Gómez', 'otro nombre (corrección) sí');
});

// --- Preferencia de horario ----------------------------------------------------------

test('preferencia: el extractor la pide con la fecha de hoy y la valida', () => {
  const ctx = ctxBase({ conversacion: { ...ctxBase().conversacion, agenda: { ofrecidos: ['2030-10-23T15:00:00-05:00'], texto: '1. Miércoles 3:00 p. m.' } } });
  const sistema = conv.solicitudExtraccion(ctx).messages[0].content;
  assert.match(sistema, /Hoy es .+\(\d{4}-\d{2}-\d{2}\)/);
  assert.match(sistema, /"preferencia_horario"/);
  const r = (json) => conv.interpretarExtraccion(openaiOk(JSON.stringify(json))).preferencia_horario;
  assert.deepEqual(r({ datos: {}, preferencia_horario: { fecha: '2030-10-23', desde: '12:00', hasta: null } }), { fecha: '2030-10-23', desde: '12:00', hasta: null });
  assert.equal(r({ datos: {}, preferencia_horario: { fecha: 'miércoles' } }), null, 'formato inválido');
});

test('preferencia: pide otra opción el miércoles y se vuelven a buscar horarios de ese día', () => {
  const agenda = require('../src/n8n/agenda');
  const ghl = require('../src/integraciones/gohighlevel');
  const pref = { fecha: '2030-10-23', desde: null, hasta: null };
  const ctx = ctxLucia({
    tenant: { ...ctxBase().tenant, parametros: PARAMS_BASICOS },
    evaluacion: { accion: 'ofrecer_agenda' },
    conversacion: { ...ctxBase().conversacion, agenda: { ofrecidos: ['2030-10-23T15:00:00-05:00'] } },
    integraciones: { calendario: { calendar_id: 'cal', horarios_a_ofrecer: 4, horarios_por_dia: 2, antelacion_minima_minutos: 0 } },
  });
  assert.deepEqual(agenda.planificarAgenda(ctx, null, pref), { paso: 'ofrecer', preferencia: pref });
  assert.equal(agenda.planificarAgenda(ctx, { horario: 1 }, pref).paso, 'reservar', 'si además eligió de la lista, se reserva');

  const s = agenda.solicitudHorarios(ctx, ghl, new Date('2030-10-20T15:00:00Z'), pref);
  assert.equal(s.solicitud.consulta.startDate, new Date('2030-10-23T05:00:00Z').getTime(), 'desde el inicio del miércoles en Bogotá');

  const body = {
    '2030-10-22': { slots: ['2030-10-22T10:00:00-05:00'] },
    '2030-10-23': { slots: ['2030-10-23T09:00:00-05:00', '2030-10-23T11:00:00-05:00', '2030-10-23T15:00:00-05:00', '2030-10-23T16:00:00-05:00'] },
  };
  const h = agenda.interpretarHorarios({ statusCode: 200, body }, ctx, ghl, new Date('2030-10-20T00:00:00Z'), pref);
  assert.deepEqual(h.ofrecidos, body['2030-10-23'].slots, 'todas las opciones del miércoles, no solo 2');
  assert.equal(h.motivo, 'preferencia');
  assert.equal(h.dia, 'miércoles 23 de octubre');

  const tarde = agenda.interpretarHorarios({ statusCode: 200, body }, ctx, ghl, new Date('2030-10-20T00:00:00Z'), { ...pref, desde: '12:00' });
  assert.deepEqual(tarde.ofrecidos, ['2030-10-23T15:00:00-05:00', '2030-10-23T16:00:00-05:00'], 'en la tarde');

  const sinCupo = agenda.interpretarHorarios({ statusCode: 200, body }, ctx, ghl, new Date('2030-10-20T00:00:00Z'), { fecha: '2030-10-24', desde: null, hasta: null });
  assert.equal(sinCupo.motivo, 'preferencia_sin_cupo');
  assert.ok(sinCupo.ofrecidos.length > 0, 'ofrece las más cercanas');

  const plantillas = Object.fromEntries(require('../config/tenants/javier-nunez/plantillas.json').filter((p) => !p.rol).map((p) => [p.clave, p.texto]));
  const texto = (ra) => conv.planificarRespuesta(ctxBase({ plantillas, evaluacion: { accion: 'ofrecer_agenda' }, resultado_agenda: ra })).respuesta_fija.texto;
  assert.match(texto({ tipo: 'preferencia', texto: h.texto, dia: h.dia }), /^Estas son las opciones disponibles para el miércoles 23 de octubre \(hora de Colombia\):\n1\. /);
  assert.match(texto({ tipo: 'preferencia_sin_cupo', texto: sinCupo.texto, dia: sinCupo.dia }), /^Para el jueves 24 de octubre no hay horarios disponibles\./);
});

test('flujo: la preferencia llega de Registrar datos hasta la consulta de horarios', async () => {
  const pref = { fecha: '2030-10-23', desde: null, hasta: null };
  const r = ctxBase({ evaluacion: { accion: 'ofrecer_agenda' }, conversacion: { ...ctxBase().conversacion, agenda: { ofrecidos: ['x'] } } });
  const plan = await ejecutarCode('Planificar agenda', { r }, { 'Registrar datos': { r: { seleccion: null, preferencia_horario: pref } } });
  assert.deepEqual(plan.json.plan, { paso: 'ofrecer', preferencia: pref });
});

// --- Sincronizar barrios ----------------------------------------------------------------

test('barrios: lee la hoja configurada y llama a app.sincronizar_barrios', () => {
  const hoja = flujoBarrios.nodes.find((n) => n.name === 'Leer hoja de barrios');
  const { hoja_barrios } = require('../config/tenants/javier-nunez/tenant.json');
  assert.equal(hoja.parameters.url, `https://sheets.googleapis.com/v4/spreadsheets/${hoja_barrios.spreadsheet_id}/values/A:Z`);
  assert.equal(hoja.parameters.nodeCredentialType, 'googleSheetsOAuth2Api');
  const pg = flujoBarrios.nodes.find((n) => n.type === 'n8n-nodes-base.postgres');
  assert.match(pg.parameters.query, /app\.sincronizar_barrios\('javier-nunez', convert_from\(decode\('\{\{ \$json\.filas_b64 \}\}'/);
  const destinos = Object.values(flujoBarrios.connections).flatMap((c) => c.main.flat().map((d) => d.node));
  for (const n of flujoBarrios.nodes) {
    if (!n.type.endsWith('Trigger')) assert.ok(destinos.includes(n.name), `nodo huérfano: ${n.name}`);
  }
});

test('barrios: el nodo Code prepara las 447 filas de la hoja de hoy', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { parsearCsv } = require('../src/cobertura/barrios');
  const filas = parsearCsv(fs.readFileSync(path.join(__dirname, '..', 'config', 'tenants', 'javier-nunez', 'barrios.csv'), 'utf8'));
  const codigo = flujoBarrios.nodes.find((n) => n.name === 'Preparar filas').parameters.jsCode;
  // Como responde values.get: encabezados y filas; Google omite las celdas vacías del final.
  const encabezados = Object.keys(filas[0]);
  const values = [encabezados, ...filas.map((f) => {
    const v = encabezados.map((h) => f[h]);
    while (v.length && v[v.length - 1] === '') v.pop();
    return v;
  })];
  const $input = { first: () => ({ json: { range: 'A1:Z448', values } }) };
  const [salida] = await new AsyncFunction('$input', 'Buffer', codigo)($input, Buffer);
  assert.equal(salida.json.filas, 447);
  assert.equal(decodificar(salida.json.filas_b64).filter((f) => f.atiende).length, 114);
  assert.equal(decodificar(salida.json.advertencias_b64)[0].fila, 113);
});

// --- Prueba del 21 oct: faltaba intencion_venta y el LLM ofreció horarios inventados ---------

test('faltan datos: pregunta guía del campo (palabras libres) y prohibición de adelantar la agenda', () => {
  const ctx = ctxBase({
    contacto: { ...ctxBase().contacto, datos: { acepta_preguntas: true, operacion: 'venta' } },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['intencion_venta'] },
  });
  const sistema = conv.planificarRespuesta(ctx).solicitud_llm.messages[0].content;
  assert.match(sistema, /con una pregunta de este sentido; puedes variar las palabras: "Para confirmar: ¿tu intención es vender el inmueble, o por ahora solo estás evaluando hacerlo\?"/);
  assert.match(sistema, /no digas que ya tienes toda la información, no hables de agendar ni ofrezcas días u horarios/);
});

test('redacción con horarios que el sistema no dio: se reemplaza por la pregunta pendiente', () => {
  const ctx = ctxBase({
    contacto: { ...ctxBase().contacto, datos: { operacion: 'venta' } },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['intencion_venta'] },
  });
  const inventado = 'Estos son los horarios disponibles: miércoles a las 10:00 a. m., jueves a las 3:00 p. m. y viernes a las 11:00 a. m.';
  const r = conv.interpretarRedaccion(openaiOk(inventado), ctx);
  assert.equal(r.texto, 'Para confirmar: ¿tu intención es vender el inmueble, o por ahora solo estás evaluando hacerlo?');
  assert.equal(r.eventos[0].nivel, 'advertencia');
  assert.equal(r.eventos[0].contexto.texto_descartado, inventado);
  assert.equal(conv.interpretarRedaccion(openaiOk('Por ahora solo tengo el jueves a las 3 p. m.'), ctx).eventos.length, 1);

  // Con la propuesta pendiente tampoco se ofrecen horarios.
  const propuesta = ctxBase({ evaluacion: { accion: 'presentar_propuesta', campos_faltantes: [] } });
  assert.equal(conv.interpretarRedaccion(openaiOk('¿Te sirve el jueves a las 15:00?'), propuesta).texto, '¿Hay algún punto que quieras aclarar antes de continuar?');

  // Con horarios del sistema (ofrecer_agenda) o sin horas, el texto se respeta.
  const agenda = ctxBase({ evaluacion: { accion: 'ofrecer_agenda', campos_faltantes: [] } });
  assert.equal(conv.interpretarRedaccion(openaiOk('Elige: 1. Viernes 9:00 a. m.'), agenda).texto, 'Elige: 1. Viernes 9:00 a. m.');
  assert.equal(conv.interpretarRedaccion(openaiOk('¿Tu apartamento tiene 3 habitaciones?'), ctx).texto, '¿Tu apartamento tiene 3 habitaciones?');
  assert.equal(conv.interpretarRedaccion(openaiOk('Hola Ana')).texto, 'Hola Ana');
});

test('solo venta: quien solo quiere arrendar recibe la plantilla solo_venta (19 oct 2026)', () => {
  const plantillas = require('../config/tenants/javier-nunez/plantillas.json');
  const saludo = plantillas.find((p) => p.clave === 'seleccion_intencion').texto;
  assert.doesNotMatch(saludo, /arrend/i);
  const ctx = ctxBase({
    plantillas: { ...ctxBase().plantillas, solo_venta: 'Solo venta.' },
    evaluacion: { resultado: 'no_calificado', accion: 'archivar', codigo_motivo: 'solo_venta', campos_faltantes: [] },
  });
  assert.equal(conv.planificarRespuesta(ctx).respuesta_fija.plantilla, 'solo_venta');
});

// --- Redacción guiada, menús y guion de Lucía (26 oct 2026) --------------------------------

const PLANTILLAS = require('../config/tenants/javier-nunez/plantillas.json');
const plantillasDe = (rol) => Object.fromEntries(PLANTILLAS
  .filter((p) => p.rol === null || p.rol === rol)
  .sort((a, b) => (a.rol === null) - (b.rol === null))
  .reverse()
  .map((p) => [p.clave, p.texto]));

test('redacción guiada: la plantilla elegida pasa al LLM con los datos exactos como marcadores', () => {
  const ctx = ctxLucia({
    plantillas: plantillasDe('lucia'),
    resultado_agenda: { tipo: 'ofrecidos', texto: '1. Martes 28 de octubre, 10:00 a. m.\n2. Miércoles 29 de octubre, 3:00 p. m.' },
  });
  const plan = conv.guiarRespuesta(ctx, conv.planificarRespuesta(ctx));
  assert.equal(plan.respuesta_fija, null, 'va al LLM');
  assert.equal(plan.guia.plantilla, 'calificado');
  assert.match(plan.guia.guia, /llamada con Javier.*\{\{horarios_disponibles\}\}/s, 'el asesor ya está, los horarios como marcador');
  assert.match(plan.guia.texto, /1\. Martes 28 de octubre/, 'texto literal de respaldo');
  assert.match(sistemaDe(plan), /con tus propias palabras/);
  assert.match(sistemaDe(plan), /\{\{horarios_disponibles\}\}/);
  assert.deepEqual(plan.opciones, { tipo: 'horarios', titulos: ['Martes 28 de octubre, 10:00 a. m.', 'Miércoles 29 de octubre, 3:00 p. m.'] });

  const redactada = conv.interpretarRedaccion(openaiOk('¡Qué bien! Tu propiedad es justo lo que trabajamos. Te propongo una llamada con Javier sin compromiso; ¿qué horario te sirve? (hora de Colombia)\n{{horarios_disponibles}}'), ctx, plan);
  assert.match(redactada.texto, /^¡Qué bien!.*\n1\. Martes 28 de octubre, 10:00 a\. m\.\n2\. Miércoles/s, 'el código rellena los horarios');
  assert.equal(redactada.plantilla, 'calificado');
  assert.deepEqual(redactada.opciones, plan.opciones);
  assert.deepEqual(redactada.eventos, []);
});

test('redacción guiada: sin marcadores, con cifras nuevas o con falla del LLM se envía el texto literal', () => {
  const ctx = ctxLucia({ plantillas: plantillasDe('lucia'), resultado_agenda: { tipo: 'ofrecidos', texto: '1. Martes 28 de octubre, 10:00 a. m.' } });
  const plan = conv.guiarRespuesta(ctx, conv.planificarRespuesta(ctx));
  for (const malo of [
    'Te propongo el martes 28 a las 10:00 a. m.',
    'Hola. {{horarios_disponibles}} {{horarios_disponibles}}',
    'En 15 minutos te escribo. {{horarios_disponibles}}',
  ]) {
    const r = conv.interpretarRedaccion(openaiOk(malo), ctx, plan);
    assert.equal(r.texto, plan.guia.texto, malo);
    assert.equal(r.eventos[0].nivel, 'advertencia');
  }
  const caida = conv.interpretarRedaccion({ error: { message: 'timeout' } }, ctx, plan);
  assert.equal(caida.texto, plan.guia.texto, 'una plantilla aprobada es mejor respaldo que la respuesta segura');
  assert.equal(caida.eventos[0].nivel, 'error');
});

test('redacción guiada: las plantillas de Meta y las respuestas sin plantilla no cambian', () => {
  const ctx = ctxLucia({ plantillas: plantillasDe('lucia'), resultado_agenda: { tipo: 'ofrecidos', texto: '1. Martes' }, plantillas_literales: ['calificado'] });
  const fija = conv.planificarRespuesta(ctx);
  assert.equal(conv.guiarRespuesta(ctx, fija), fija);
  const libre = conv.planificarRespuesta(ctxLucia({ evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['ciudad'] } }));
  assert.equal(conv.guiarRespuesta(ctx, libre), libre);
});

test('redacción guiada: sin rol, la selección de intención también se redacta', () => {
  const ctx = ctxBase({ rol: null, tenant: { ...ctxBase().tenant, parametros: PARAMS }, plantillas: plantillasDe(null) });
  const plan = conv.guiarRespuesta(ctx, conv.planificarRespuesta(ctx));
  assert.equal(plan.guia.plantilla, 'seleccion_intencion');
  assert.match(sistemaDe(plan), /asistente virtual de Javier Núñez del Toro/);
});

test('propuesta enviada con otras palabras: se reconoce por la plantilla y no se repite', () => {
  const ctx = ctxLucia({
    plantillas: plantillasDe('lucia'),
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Ana Gómez' } },
    evaluacion: { resultado: 'calificado', accion: 'presentar_propuesta' },
  });
  assert.equal(conv.planificarRespuesta(ctx).respuesta_fija.plantilla, 'propuesta');
  const enviada = { ...ctx, historial: [...ctx.historial, { direccion: 'saliente', contenido: 'Javier trabaja en exclusiva…', plantilla: 'propuesta' }] };
  assert.equal(conv.planificarRespuesta(enviada).respuesta_fija, null);
});

test('propuesta con video: con video_url se usa propuesta_video y el enlace es un dato exacto', () => {
  const params = { ...PARAMS, comercial: { ...PARAMS.comercial, propuesta: { ...PARAMS.comercial.propuesta, video_url: 'https://x.co/proceso' } } };
  const ctx = ctxLucia({
    tenant: { ...ctxBase().tenant, parametros: params },
    plantillas: plantillasDe('lucia'),
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Ana Gómez' } },
    evaluacion: { resultado: 'calificado', accion: 'presentar_propuesta' },
  });
  const rf = conv.planificarRespuesta(ctx).respuesta_fija;
  assert.equal(rf.plantilla, 'propuesta_video');
  assert.match(rf.texto, /https:\/\/x\.co\/proceso/);
  assert.match(rf.guia, /\{\{video_url\}\}/);
  assert.equal(meta.solicitudEnvio(ctx, rf.texto).cuerpo.text.preview_url, true, 'vista previa del enlace');
});

test('referencia por valor (< 450 M) y por barrio: plantilla e instrucción propias', () => {
  const valor = ctxLucia({ plantillas: plantillasDe('lucia'), evaluacion: { resultado: 'no_calificado', accion: 'archivar', codigo_motivo: 'valor_minimo' }, estado_anterior: 'informacion_incompleta' });
  assert.equal(conv.planificarRespuesta(valor).respuesta_fija.plantilla, 'referencia_valor');
  const barrio = { ...valor, evaluacion: { ...valor.evaluacion, codigo_motivo: 'cobertura_barrio' } };
  assert.equal(conv.planificarRespuesta(barrio).respuesta_fija.plantilla, 'fuera_cobertura_barrio');
  const ciudadYValor = { ...valor, evaluacion: { ...valor.evaluacion, codigo_motivo: 'cobertura_ciudad,valor_minimo' } };
  assert.equal(conv.planificarRespuesta(ciudadYValor).respuesta_fija.plantilla, 'fuera_cobertura', 'la ciudad va primero');

  const despues = (ev) => sistemaDe(conv.planificarRespuesta({ ...valor, evaluacion: { ...valor.evaluacion, codigo_motivo: ev }, estado_anterior: 'no_calificado', contacto: { ...valor.contacto, estado: 'no_calificado' } }));
  assert.match(despues('valor_minimo'), /desde 450 millones de pesos.*No digas cifras/s);
  assert.match(despues('cobertura_barrio'), /no es una de las zonas que Javier atiende/);
  assert.match(despues('valor_minimo'), /no digas que hay un agente disponible/);
  for (const clave of ['fuera_cobertura', 'fuera_cobertura_barrio', 'referencia_valor']) {
    assert.doesNotMatch(PLANTILLAS.find((p) => p.clave === clave).texto, /se comunicará|te contactará|hoy mismo/, `${clave} no promete contacto`);
  }
});

test('prioridad B: la primera oferta de horarios usa calificado_futuro', () => {
  const ctx = ctxLucia({
    plantillas: plantillasDe('lucia'),
    evaluacion: { resultado: 'calificado', accion: 'ofrecer_agenda', prioridad: 'baja', agendar_desde_dias: 14 },
    resultado_agenda: { tipo: 'ofrecidos', texto: '1. Lunes 9 de noviembre, 10:00 a. m.' },
  });
  assert.equal(conv.planificarRespuesta(ctx).respuesta_fija.plantilla, 'calificado_futuro');
});

test('cobertura por barrio: se resuelve con la hoja y un barrio desconocido solo deja advertencia', () => {
  const { resolverBarrio } = require('../src/cobertura/barrios');
  const barrios = [
    { localidad: 'Chapinero', codigo_upz: 88, upz: 'El Refugio', barrio: 'El Nogal', alias: [], atiende: true },
    { localidad: 'Bosa', codigo_upz: 85, upz: 'Bosa Central', barrio: 'Bosa Centro', alias: [], atiende: false },
  ];
  const datos = { nombre: 'Ana Gómez', telefono: '+573001112233', operacion: 'venta', ciudad: 'Bogotá', tipo_inmueble: 'apartamento' };
  const turno = (barrio) => conv.evaluarTurno(ctxLucia({ barrios_cobertura: barrios, contacto: { ...ctxBase().contacto, datos: { ...datos, barrio } } }), evaluarCalificacion, resolverBarrio);
  const fuera = turno('Bosa Centro');
  assert.equal(fuera.evaluacion.resultado, 'no_calificado');
  assert.equal(fuera.evaluacion.codigo_motivo, 'cobertura_barrio');
  assert.equal(turno('El Nogal').evaluacion.resultado, 'informacion_incompleta', 'atendido: sigue la calificación');
  const raro = turno('Barrio Inventado');
  assert.equal(raro.evaluacion.resultado, 'informacion_incompleta', 'desconocido no descarta');
  assert.equal(raro.eventos[0].operacion, 'cobertura_barrio');
  // Sin barrios en el contexto (Sonia, o sin barrio aún) no cambia nada.
  assert.deepEqual(conv.evaluarTurno(ctxLucia({ contacto: { ...ctxBase().contacto, datos: { ...datos, barrio: 'Bosa Centro' } } }), evaluarCalificacion, resolverBarrio).eventos, []);
});

test('menús: el campo siguiente con opciones las adjunta y avisa al LLM que no las enumere', () => {
  const ctx = ctxLucia({
    contacto: { ...ctxBase().contacto, datos: { acepta_preguntas: true } },
    evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['estado_ocupacion', 'plazo_meses'] },
  });
  const plan = conv.planificarRespuesta(ctx);
  assert.deepEqual(plan.opciones, { tipo: 'campo', titulos: ['Desocupado', 'Arrendado', 'Vivo allí'] });
  assert.match(sistemaDe(plan), /No las enumeres en el texto/);
  const sinMenu = conv.planificarRespuesta({ ...ctx, evaluacion: { accion: 'solicitar_datos', campos_faltantes: ['barrio'] } });
  assert.equal(sinMenu.opciones, undefined);
  const r = conv.interpretarRedaccion(openaiOk('Gracias. ¿Cómo está tu inmueble hoy?'), ctx, plan);
  assert.deepEqual(r.opciones, plan.opciones);
});

test('menús en WhatsApp: botones hasta 3, lista para más; Instagram con emojis', () => {
  const wa = ctxBase();
  const botones = meta.solicitudEnvio(wa, '¿Cómo está tu inmueble?', null, { tipo: 'campo', titulos: ['Desocupado', 'Arrendado', 'Vivo allí'] }).cuerpo;
  assert.equal(botones.type, 'interactive');
  assert.equal(botones.interactive.type, 'button');
  assert.deepEqual(botones.interactive.action.buttons.map((b) => b.reply.title), ['Desocupado', 'Arrendado', 'Vivo allí']);
  const lista = meta.solicitudEnvio(wa, '¿En cuánto tiempo?', null, { tipo: 'campo', titulos: luciaReal.campos.find((c) => c.clave === 'plazo_meses').menu.map((m) => m.titulo) }).cuerpo.interactive;
  assert.equal(lista.type, 'list');
  assert.ok(lista.action.sections[0].rows.every((r) => r.title.length <= 24));
  const horarios = meta.solicitudEnvio(wa, 'Elige:\n1. Martes', null, { tipo: 'horarios', titulos: ['Martes 28 de octubre, 10:00 a. m.'] }).cuerpo.interactive;
  assert.deepEqual(horarios.action.sections[0].rows[0], { id: 'horario_1', title: 'Opción 1', description: 'Martes 28 de octubre, 10:00 a. m.' });
  assert.equal(meta.solicitudEnvio(wa, 'Hola', { url: 'https://x.co/d.pdf', nombre_archivo: 'd.pdf' }, { tipo: 'campo', titulos: ['A', 'B'] }).cuerpo.type, 'document', 'un documento no lleva botones');

  const ig = ctxBase({ canal: { id: 'k2', tipo: 'instagram_dm', identificador_externo: 'IG1' }, contacto: { ...ctxBase().contacto, instagram_id: 'U1' } });
  assert.equal(meta.solicitudEnvio(ig, '¿Cómo está tu inmueble?', null, { tipo: 'campo', titulos: ['Desocupado', 'Arrendado'] }).cuerpo.message.text, '¿Cómo está tu inmueble?\n\n1️⃣ Desocupado\n2️⃣ Arrendado');
  assert.equal(meta.solicitudEnvio(ig, 'Elige:\n1. Martes\n2. Jueves', null, { tipo: 'horarios', titulos: ['Martes', 'Jueves'] }).cuerpo.message.text, 'Elige:\n1️⃣ Martes\n2️⃣ Jueves');
});

test('respuesta de una lista de WhatsApp: llega con la descripción para leer el horario', () => {
  const m = meta.normalizarWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'PN1' },
    messages: [{ id: 'wamid.9', from: '573001112233', type: 'interactive', interactive: { list_reply: { id: 'horario_2', title: 'Opción 2', description: 'Miércoles 29 de octubre, 3:00 p. m.' } } }],
  } }] }] });
  assert.equal(m[0].texto, 'Opción 2 — Miércoles 29 de octubre, 3:00 p. m.');
});

test('flujo: planificar pasa por guiarRespuesta y el envío lleva las opciones', async () => {
  const ctx = ctxLucia({ plantillas: plantillasDe('lucia'), resultado_agenda: { tipo: 'ofrecidos', texto: '1. Martes 28 de octubre, 10:00 a. m.' } });
  const planificado = await ejecutarCode('Planificar respuesta', { r: ctx });
  assert.equal(planificado.json.plan.guia.plantilla, 'calificado');
  const redactado = await ejecutarCode('Interpretar redacción', openaiOk('Te propongo una llamada con Javier. ¿Cuál prefieres?\n{{horarios_disponibles}}'), { 'Planificar respuesta': planificado.json });
  const envio = await ejecutarCode('Preparar envío', redactado.json);
  assert.equal(envio.json.envio.cuerpo.type, 'interactive');
  assert.match(envio.json.envio.cuerpo.interactive.body.text, /1\. Martes 28 de octubre/);
});

test('propuesta: condiciones del guion como parámetros (2,5 %, exclusividad, salida, informe)', () => {
  const lucia = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'prompts', 'lucia.md'), 'utf8');
  const ctx = ctxLucia({ rol: { prompt_sistema: lucia.replace('{{campos}}', '- datos') }, evaluacion: { accion: 'presentar_propuesta' } });
  const sistema = sistemaDe(conv.planificarRespuesta(ctx));
  assert.match(sistema, /comisión del 5 %, que solo se paga si se concreta la venta/);
  assert.match(sistema, /Si el propietario consigue por su cuenta al comprador durante la exclusividad, la comisión es del 2,5 %\./);
  assert.match(sistema, /La exclusividad es por 6 meses/);
  assert.match(sistema, /Al final del plazo, se revisan juntos los resultados.*se termina el acuerdo\./s);
  assert.match(sistema, /no las enumeres al presentar la propuesta/, 'las condiciones son para dudas, no para la presentación');
  assert.doesNotMatch(sistema, /dJavier/);
  assert.match(sistema, /informe mensual/);
  const sinCondiciones = { ...PARAMS, comercial: { ...PARAMS.comercial, propuesta: { exclusiva: true, comision_pct: 5 } } };
  const otro = sistemaDe(conv.planificarRespuesta({ ...ctx, tenant: { ...ctx.tenant, parametros: sinCondiciones } }));
  assert.doesNotMatch(otro, /2,5 %|exclusividad es por|se entrega un informe mensual/, 'en null no se mencionan');
  assert.match(otro, /Condiciones aprobadas.*ninguna adicional: lo demás lo aclara Javier/);
});

test('propuesta con video: menciona los minutos configurados, y sin duración no', () => {
  const conVideo = (minutos) => ({ ...PARAMS, comercial: { ...PARAMS.comercial, propuesta: { ...PARAMS.comercial.propuesta, video_url: 'https://x.co/v', video_minutos: minutos } } });
  const rf = (minutos) => conv.planificarRespuesta(ctxLucia({
    tenant: { ...ctxBase().tenant, parametros: conVideo(minutos) },
    plantillas: plantillasDe('lucia'),
    contacto: { ...ctxBase().contacto, datos: { nombre: 'Ana Gómez' } },
    evaluacion: { resultado: 'calificado', accion: 'presentar_propuesta' },
  })).respuesta_fija;
  assert.match(rf(3).texto, /un video de 3 minutos con nuestro proceso/);
  assert.match(rf(3).guia, /\{\{video_minutos\}\} minutos/, 'la duración es un dato exacto');
  assert.match(rf(null).texto, /un video con nuestro proceso/);
  assert.doesNotMatch(rf(null).texto, /\{\{/);
});

test('vacaciones: al ofrecer horarios se usa calificado_vacaciones con la fecha de regreso', () => {
  const ctx = (ahora) => ctxLucia({
    ahora,
    plantillas: plantillasDe('lucia'),
    resultado_agenda: { tipo: 'ofrecidos', texto: '1. Martes 12 de enero, 3:30 p. m.' },
  });
  const rf = conv.planificarRespuesta(ctx('2026-12-28T15:00:00Z')).respuesta_fija;
  assert.equal(rf.plantilla, 'calificado_vacaciones');
  assert.match(rf.texto, /Javier está de vacaciones y retoma las llamadas el martes 12 de enero/);
  assert.equal(conv.planificarRespuesta(ctx('2026-12-01T15:00:00Z')).respuesta_fija.plantilla, 'calificado', 'fuera de vacaciones, la plantilla normal');
});
