'use strict';

// Genera n8n/agente-inmobiliario.json (flujo de n8n) a partir de src/ y prompts/.
// Uso: node scripts/generar-n8n.js [--check]
//   --check  falla si el archivo no está actualizado.
//
// Los nodos Code incrustan src/n8n/*.js y src/calificacion/evaluar.js, así la
// lógica que corre en n8n es la misma que prueban tests/*.test.js. La BD se
// usa solo a través de las funciones de supabase/migrations/0002_funciones_n8n.sql.

const fs = require('node:fs');
const path = require('node:path');

const raiz = path.resolve(__dirname, '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');
const destino = path.join(raiz, 'n8n', 'agente-inmobiliario.json');

const RUTA_WEBHOOK = 'agente-inmobiliario/meta';

// --- Código incrustado ------------------------------------------------------------

// Cada módulo queda en su propio ámbito: `module.exports =` pasa a ser `return`.
function modulo(nombre, archivo) {
  const fuente = leer(archivo).replace(/^module\.exports = /m, 'return ');
  return `const ${nombre} = (function () {\n${fuente.trim()}\n})();`;
}

const MODULOS = {
  meta: () => modulo('meta', 'src/n8n/meta.js'),
  conversacion: () => modulo('conversacion', 'src/n8n/conversacion.js'),
  geocodificacion: () => modulo('geocodificacion', 'src/n8n/geocodificacion.js'),
  evaluar: () => modulo('evaluar', 'src/calificacion/evaluar.js'),
};

const B64 = "const b64 = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');";

function codigo(modulos, cuerpo) {
  return [
    '// GENERADO por scripts/generar-n8n.js desde src/. Editar allí, no aquí.',
    ...modulos.map((m) => MODULOS[m]()),
    B64,
    '',
    cuerpo.trim(),
    '',
  ].join('\n');
}

// --- Fábrica de nodos ----------------------------------------------------------------

const nodos = [];
const conexiones = {};
let secuencia = 0;

function idNodo() {
  secuencia += 1;
  return `a91e0000-0000-4000-8000-${String(secuencia).padStart(12, '0')}`;
}

function nodo(nombre, tipo, version, posicion, parametros, extra = {}) {
  nodos.push({ parameters: parametros, id: idNodo(), name: nombre, type: tipo, typeVersion: version, position: posicion, ...extra });
  return nombre;
}

function conectar(desde, hacia, salida = 0) {
  conexiones[desde] = conexiones[desde] || { main: [] };
  while (conexiones[desde].main.length <= salida) conexiones[desde].main.push([]);
  conexiones[desde].main[salida].push({ node: hacia, type: 'main', index: 0 });
}

const code = (nombre, pos, modulos, cuerpo, porItem = true, nota) => nodo(
  nombre, 'n8n-nodes-base.code', 2, pos,
  { ...(porItem ? { mode: 'runOnceForEachItem' } : {}), jsCode: codigo(modulos, cuerpo) },
  nota ? { notes: nota, notesInFlow: true } : {},
);

const postgres = (nombre, pos, consulta) => nodo(
  nombre, 'n8n-nodes-base.postgres', 2.5, pos,
  { operation: 'executeQuery', query: `=${consulta}`, options: { queryBatching: 'independently' } },
  { notes: 'Credencial Postgres: Supabase agente-inmobiliario', alwaysOutputData: false },
);

// Las cargas útiles viajan en base64 para que ningún texto del usuario se
// interprete como SQL.
const jsonb = (campo = 'payload_b64') => `convert_from(decode('{{ $json.${campo} }}', 'base64'), 'UTF8')::jsonb`;
const llamada = (funcion) => `select app.${funcion}('{{ $json.t }}'::uuid, '{{ $json.c }}'::uuid, ${jsonb()}) as r`;

const si = (nombre, pos, expresion) => nodo(nombre, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      id: idNodo(),
      leftValue: `={{ ${expresion} }}`,
      rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
});

const http = (nombre, pos, parametros, nota) => nodo(
  nombre, 'n8n-nodes-base.httpRequest', 4.2, pos,
  { ...parametros, options: { timeout: 30000, ...(parametros.options || {}) } },
  { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, notes: nota, notesInFlow: true },
);

const openai = (nombre, pos, expresionCuerpo) => http(nombre, pos, {
  method: 'POST',
  url: 'https://api.openai.com/v1/chat/completions',
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'openAiApi',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: `={{ JSON.stringify(${expresionCuerpo}) }}`,
}, 'Credencial: OpenAI');

const graph = (nombre, pos, nota) => http(nombre, pos, {
  method: 'POST',
  url: '={{ $json.envio.url }}',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.envio.cuerpo) }}',
}, nota);

// Contexto compacto para las llamadas a la BD: tenant (t), conversación (c).
const SALIDA_BD = (expresionCtx, expresionPayload) =>
  `const r = ${expresionCtx};\nreturn { json: { r, t: r.tenant.id, c: r.conversacion.id, payload_b64: b64(${expresionPayload}) } };`;

const x = (col) => col * 240;

// --- Verificación del webhook (GET) -------------------------------------------------

nodo('Meta: verificación (GET)', 'n8n-nodes-base.webhook', 2, [x(0), -400], {
  httpMethod: 'GET', path: RUTA_WEBHOOK, responseMode: 'responseNode', options: {},
}, { webhookId: 'b7c4e2a0-6f1d-4c3e-9a51-2d8f0e6b1c01' });

code('Preparar token', [x(1), -400], [], `
const q = $json.query || {};
return { json: { modo: q['hub.mode'] || '', challenge: q['hub.challenge'] || '', token_b64: b64(String(q['hub.verify_token'] || '')) } };
`);

postgres('Validar token', [x(2), -400],
  "select app.verificar_token_meta(convert_from(decode('{{ $json.token_b64 }}', 'base64'), 'UTF8')::jsonb #>> '{}') as valido");

si('¿Token válido?', [x(3), -400], "$json.valido === true && $('Preparar token').item.json.modo === 'subscribe'");

nodo('Responder challenge', 'n8n-nodes-base.respondToWebhook', 1.1, [x(4), -480], {
  respondWith: 'text', responseBody: "={{ $('Preparar token').item.json.challenge }}", options: { responseCode: 200 },
});
nodo('Responder 403', 'n8n-nodes-base.respondToWebhook', 1.1, [x(4), -320], {
  respondWith: 'text', responseBody: 'Forbidden', options: { responseCode: 403 },
});

conectar('Meta: verificación (GET)', 'Preparar token');
conectar('Preparar token', 'Validar token');
conectar('Validar token', '¿Token válido?');
conectar('¿Token válido?', 'Responder challenge', 0);
conectar('¿Token válido?', 'Responder 403', 1);

// --- Eventos (POST) ------------------------------------------------------------------

nodo('Meta: eventos (POST)', 'n8n-nodes-base.webhook', 2, [x(0), 0], {
  httpMethod: 'POST', path: RUTA_WEBHOOK, responseMode: 'onReceived', options: { rawBody: true },
}, { webhookId: 'b7c4e2a0-6f1d-4c3e-9a51-2d8f0e6b1c02' });

code('Preparar firma', [x(1), 0], ['meta'], `
const entrada = $input.first();
let crudo;
try {
  crudo = await this.helpers.getBinaryDataBuffer(0, 'data');
} catch (e) {
  crudo = Buffer.from('');   // sin cuerpo crudo la firma no puede validar
}
return [{ json: meta.prepararFirma(crudo, entrada.json.headers) }];
`, false, 'La firma se compara en Supabase con el secreto de Vault "meta_app_secret".');

postgres('Verificar firma', [x(2), 0],
  "select app.verificar_firma_meta(decode('{{ $json.cuerpo_b64 }}', 'base64'), '{{ $json.firma }}') as valida");

si('¿Firma válida?', [x(3), 0], '$json.valida === true');

code('Rechazar firma inválida', [x(4), 160], [], `
throw new Error('Webhook de Meta con firma inválida o sin secreto configurado en Vault: se descarta.');
`, false);

code('Normalizar eventos de Meta', [x(4), 0], ['meta'], `
const cuerpo = $('Meta: eventos (POST)').first().json.body;
return meta.normalizarWebhook(cuerpo).map((m) => ({ json: { ...m, payload_b64: b64(m) } }));
`, false);

postgres('Registrar mensaje entrante', [x(5), 0], `select app.recibir_mensaje(${jsonb()}) as r`);

si('¿Mensaje nuevo?', [x(6), 0], "$json.r.estado === 'ok'");
si('¿Comentario?', [x(7), 240], "$json.r.estado === 'comentario' && !!$json.r.texto");

code('Preparar respuesta a comentario', [x(8), 240], ['meta'], `
return { json: { envio: meta.solicitudRespuestaComentario($json.r.comentario_id, $json.r.texto) } };
`);
graph('Instagram: responder comentario', [x(9), 240], 'Credencial Header Auth: Meta Instagram');

conectar('Meta: eventos (POST)', 'Preparar firma');
conectar('Preparar firma', 'Verificar firma');
conectar('Verificar firma', '¿Firma válida?');
conectar('¿Firma válida?', 'Normalizar eventos de Meta', 0);
conectar('¿Firma válida?', 'Rechazar firma inválida', 1);
conectar('Normalizar eventos de Meta', 'Registrar mensaje entrante');
conectar('Registrar mensaje entrante', '¿Mensaje nuevo?');
conectar('¿Mensaje nuevo?', '¿Tiene rol?', 0);
conectar('¿Mensaje nuevo?', '¿Comentario?', 1);
conectar('¿Comentario?', 'Preparar respuesta a comentario', 0);
conectar('Preparar respuesta a comentario', 'Instagram: responder comentario');

// --- Clasificación de intención --------------------------------------------------------

si('¿Tiene rol?', [x(7), -80], '!!$json.r.rol');

code('Preparar clasificación', [x(8), -320], ['conversacion'], `
const PROMPT_CLASIFICADOR = ${JSON.stringify(leer('prompts', 'clasificador.md').trim())};
return { json: { r: $json.r, solicitud: conversacion.solicitudClasificacion($json.r, PROMPT_CLASIFICADOR) } };
`);
openai('OpenAI: clasificar intención', [x(9), -320], '$json.solicitud');
code('Interpretar intención', [x(10), -320], ['conversacion'],
  SALIDA_BD("$('Preparar clasificación').item.json.r", 'conversacion.interpretarClasificacion($json)'));
postgres('Asignar rol', [x(11), -320], llamada('asignar_rol'));
si('¿Rol asignado?', [x(12), -320], '!!$json.r.rol');

conectar('¿Tiene rol?', 'Preparar extracción', 0);
conectar('¿Tiene rol?', 'Preparar clasificación', 1);
conectar('Preparar clasificación', 'OpenAI: clasificar intención');
conectar('OpenAI: clasificar intención', 'Interpretar intención');
conectar('Interpretar intención', 'Asignar rol');
conectar('Asignar rol', '¿Rol asignado?');
conectar('¿Rol asignado?', 'Preparar extracción', 0);
conectar('¿Rol asignado?', 'Planificar respuesta', 1);

// --- Extracción, verificación y evaluación ---------------------------------------------

code('Preparar extracción', [x(13), -80], ['conversacion'], `
return { json: { r: $json.r, solicitud: conversacion.solicitudExtraccion($json.r) } };
`);
openai('OpenAI: extraer datos', [x(14), -80], '$json.solicitud');
code('Interpretar extracción', [x(15), -80], ['conversacion'],
  SALIDA_BD("$('Preparar extracción').item.json.r", 'conversacion.interpretarExtraccion($json)'));
postgres('Registrar datos', [x(16), -80], llamada('registrar_datos'));
si('¿Verificar dirección?', [x(17), -80], '$json.r.verificacion_pendiente === true');

code('Preparar geocodificación', [x(18), -240], ['geocodificacion'], `
const r = $json.r;
return { json: { r, solicitud: geocodificacion.solicitudGeocodificacion(r.direccion_a_verificar, r.integraciones.geocodificacion) } };
`);
http('Google Maps: geocodificar', [x(19), -240], {
  method: 'GET',
  url: '={{ $json.solicitud.url }}',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpQueryAuth',
  sendQuery: true,
  specifyQuery: 'json',
  jsonQuery: '={{ JSON.stringify($json.solicitud.consulta) }}',
}, 'Credencial Query Auth: Google Maps (parámetro "key")');
code('Clasificar dirección', [x(20), -240], ['geocodificacion'],
  SALIDA_BD("$('Preparar geocodificación').item.json.r", "geocodificacion.clasificarGeocodificacion($json, $('Preparar geocodificación').item.json.r.contacto.datos.ciudad)"));
postgres('Registrar verificación', [x(21), -240], llamada('registrar_verificacion'));

code('Evaluar calificación', [x(22), -80], ['evaluar', 'conversacion'],
  SALIDA_BD('$json.r', 'conversacion.evaluarTurno(r, evaluar.evaluarCalificacion)'));
postgres('Guardar evaluación', [x(23), -80], llamada('guardar_evaluacion'));

conectar('Preparar extracción', 'OpenAI: extraer datos');
conectar('OpenAI: extraer datos', 'Interpretar extracción');
conectar('Interpretar extracción', 'Registrar datos');
conectar('Registrar datos', '¿Verificar dirección?');
conectar('¿Verificar dirección?', 'Preparar geocodificación', 0);
conectar('¿Verificar dirección?', 'Evaluar calificación', 1);
conectar('Preparar geocodificación', 'Google Maps: geocodificar');
conectar('Google Maps: geocodificar', 'Clasificar dirección');
conectar('Clasificar dirección', 'Registrar verificación');
conectar('Registrar verificación', 'Evaluar calificación');
conectar('Evaluar calificación', 'Guardar evaluación');
conectar('Guardar evaluación', 'Planificar respuesta');

// --- Respuesta y envío ------------------------------------------------------------------

code('Planificar respuesta', [x(24), -80], ['conversacion'], `
return { json: { r: $json.r, plan: conversacion.planificarRespuesta($json.r) } };
`);
si('¿Respuesta fija?', [x(25), -80], '!!$json.plan.respuesta_fija');
openai('OpenAI: redactar respuesta', [x(26), -240], '$json.plan.solicitud_llm');
code('Interpretar redacción', [x(27), -240], ['conversacion'], `
const previo = $('Planificar respuesta').item.json;
const redaccion = conversacion.interpretarRedaccion($json);
return { json: { r: previo.r, respuesta: { ...redaccion, eventos: [...previo.plan.eventos, ...redaccion.eventos] } } };
`);

code('Preparar envío', [x(28), -80], ['meta'], `
const respuesta = $json.respuesta || { ...$json.plan.respuesta_fija, eventos: $json.plan.eventos };
return { json: { r: $json.r, respuesta, envio: meta.solicitudEnvio($json.r, respuesta.texto) } };
`);
si('¿WhatsApp?', [x(29), -80], "$json.r.canal.tipo === 'whatsapp'");
graph('WhatsApp: enviar', [x(30), -240], 'Credencial Header Auth: Meta WhatsApp');
graph('Instagram: enviar', [x(30), 80], 'Credencial Header Auth: Meta Instagram');
code('Resultado del envío', [x(31), -80], ['meta'], `
const previo = $('Preparar envío').item.json;
const envio = meta.interpretarEnvio($json);
const p = { texto: previo.respuesta.texto, plantilla: previo.respuesta.plantilla, eventos: previo.respuesta.eventos, ...envio };
return { json: { t: previo.r.tenant.id, c: previo.r.conversacion.id, payload_b64: b64(p) } };
`);
postgres('Registrar respuesta', [x(32), -80], llamada('registrar_respuesta'));

conectar('Planificar respuesta', '¿Respuesta fija?');
conectar('¿Respuesta fija?', 'Preparar envío', 0);
conectar('¿Respuesta fija?', 'OpenAI: redactar respuesta', 1);
conectar('OpenAI: redactar respuesta', 'Interpretar redacción');
conectar('Interpretar redacción', 'Preparar envío');
conectar('Preparar envío', '¿WhatsApp?');
conectar('¿WhatsApp?', 'WhatsApp: enviar', 0);
conectar('¿WhatsApp?', 'Instagram: enviar', 1);
conectar('WhatsApp: enviar', 'Resultado del envío');
conectar('Instagram: enviar', 'Resultado del envío');
conectar('Resultado del envío', 'Registrar respuesta');

// --- Salida ---------------------------------------------------------------------------------

const flujo = {
  name: 'Agente inmobiliario: Meta (Lucía y Sonia)',
  nodes: nodos,
  connections: conexiones,
  settings: { executionOrder: 'v1' },
};

const contenido = `${JSON.stringify(flujo, null, 2)}\n`;

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '';
    if (actual !== contenido) {
      console.error('n8n/agente-inmobiliario.json no está actualizado. Ejecuta: node scripts/generar-n8n.js');
      process.exit(1);
    }
    console.log('n8n/agente-inmobiliario.json está actualizado.');
  } else {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, contenido);
    console.log(`Generado ${path.relative(raiz, destino)}`);
  }
}

module.exports = { flujo };
