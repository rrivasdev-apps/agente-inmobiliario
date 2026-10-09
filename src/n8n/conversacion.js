'use strict';

/**
 * Turno de conversación: solicitudes a OpenAI y decisión de la respuesta.
 *
 * El LLM hace tres cosas acotadas: clasificar la intención, extraer datos y
 * redactar el mensaje. La calificación la decide src/calificacion/evaluar.js
 * y las respuestas sensibles (selección de intención, no calificado,
 * dirección ambigua, agenda) usan plantillas fijas del tenant.
 *
 * `ctx` es el contexto que devuelve app.contexto_conversacion.
 */

const MODELO_POR_DEFECTO = 'gpt-4.1-mini';
const MENSAJES_EN_CONTEXTO = 20;
const NOMBRE_CANAL = { whatsapp: 'WhatsApp', instagram_dm: 'Instagram', facebook_messenger: 'Messenger' };

// AC 46: respuesta segura cuando el LLM falla.
const RESPUESTA_SEGURA = 'Gracias por tu mensaje. Tuvimos un inconveniente técnico; en breve continuamos la conversación por este medio.';

function modelo(ctx) {
  const m = ctx.integraciones && ctx.integraciones.llm && ctx.integraciones.llm.modelo;
  return m && !String(m).startsWith('PENDIENTE') ? m : MODELO_POR_DEFECTO;
}

function rellenar(texto, valores) {
  return String(texto).replace(/\{\{(\w+)\}\}/g, (todo, clave) => (valores[clave] !== undefined ? valores[clave] : todo));
}

function mensajesHistorial(ctx) {
  return (ctx.historial || [])
    .slice(-MENSAJES_EN_CONTEXTO)
    .map((m) => ({ role: m.direccion === 'entrante' ? 'user' : 'assistant', content: m.contenido }));
}

function evento(nivel, proveedor, operacion, mensaje, contexto) {
  return { nivel, proveedor, operacion, mensaje, contexto: contexto || {} };
}

/** Contenido del primer choice o un error legible. */
function contenidoOpenAI(respuesta) {
  const r = respuesta || {};
  if (r.error) return { error: r.error.message || JSON.stringify(r.error) };
  const c = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
  if (typeof c !== 'string' || !c.trim()) return { error: 'Respuesta de OpenAI sin contenido' };
  return { contenido: c.trim() };
}

function jsonOpenAI(respuesta) {
  const r = contenidoOpenAI(respuesta);
  if (r.error) return r;
  try {
    return { json: JSON.parse(r.contenido) };
  } catch (e) {
    return { error: `JSON inválido de OpenAI: ${r.contenido.slice(0, 200)}` };
  }
}

// --- Clasificación de intención (AC 06, AC 07) --------------------------------

function solicitudClasificacion(ctx, promptClasificador) {
  const recientes = (ctx.historial || []).filter((m) => m.direccion === 'entrante').slice(-3).map((m) => m.contenido);
  return {
    model: modelo(ctx),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: promptClasificador },
      { role: 'user', content: recientes.join('\n') },
    ],
  };
}

function interpretarClasificacion(respuesta) {
  const r = jsonOpenAI(respuesta);
  if (r.error) {
    return { intencion: 'ambigua', eventos: [evento('error', 'openai', 'clasificar_intencion', r.error)] };
  }
  const { intencion, confianza } = r.json || {};
  const valida = ['vender', 'comprar'].includes(intencion) && Number(confianza) >= 0.7;
  return { intencion: valida ? intencion : 'ambigua', eventos: [] };
}

// --- Extracción de datos ----------------------------------------------------------

function describirCampo(c) {
  const tipo = c.tipo === 'opcion' ? `una de: ${c.opciones.join(', ')}`
    : c.tipo === 'booleano' ? 'true o false'
      : c.tipo === 'numero' ? 'número sin separadores ni unidades'
        : 'texto';
  return `- ${c.clave} (${tipo}): ${c.etiqueta}${c.descripcion ? `. ${c.descripcion}` : ''}`;
}

function solicitudExtraccion(ctx) {
  const sistema = [
    'Extraes datos de una conversación inmobiliaria. No conversas.',
    'Devuelve solo JSON con la forma {"datos": {...}}.',
    'Incluye únicamente claves de esta lista y solo valores que la persona dijo de forma explícita.',
    'Si la persona corrigió un dato, usa el valor más reciente. Omite lo que no sepas; nunca adivines.',
    'Campos:',
    ...ctx.rol.campos.map(describirCampo),
    '',
    `Datos ya registrados: ${JSON.stringify(ctx.contacto.datos || {})}`,
  ].join('\n');

  return {
    model: modelo(ctx),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sistema }, ...mensajesHistorial(ctx)],
  };
}

function interpretarExtraccion(respuesta) {
  const r = jsonOpenAI(respuesta);
  if (r.error) {
    // Sin extracción el turno continúa con los datos que ya había (AC 46).
    return { datos: {}, eventos: [evento('error', 'openai', 'extraer_datos', r.error)] };
  }
  const datos = r.json && typeof r.json.datos === 'object' && !Array.isArray(r.json.datos) ? r.json.datos : {};
  return { datos, eventos: [] };
}

// --- Evaluación ----------------------------------------------------------------------

/** Ejecuta el evaluador determinista con la configuración del rol. */
function evaluarTurno(ctx, evaluarCalificacion) {
  try {
    return {
      evaluacion: evaluarCalificacion({
        criterios: ctx.rol.criterios,
        requiereVerificacionDireccion: ctx.rol.requiere_verificacion_direccion,
        datos: ctx.contacto.datos,
        verificacionDireccion: ctx.verificacion,
      }),
      eventos: [],
    };
  } catch (e) {
    // Configuración inválida: no se califica ni se descarta a nadie.
    return {
      evaluacion: { resultado: 'informacion_incompleta', accion: 'solicitar_datos', campos_faltantes: [], reglas: [], motivo: e.message, codigo_motivo: 'error_configuracion' },
      eventos: [evento('error', null, 'evaluar_calificacion', e.message)],
    };
  }
}

// --- Respuesta ----------------------------------------------------------------------

const PLANTILLA_POR_ACCION = {
  archivar: 'no_calificado',
  aclarar_direccion: 'direccion_ambigua',
  // Etapa 4: mientras el calendario no esté conectado, el contacto calificado
  // queda registrado y el equipo agenda manualmente (ver evento).
  ofrecer_agenda: 'falla_agenda',
};

// Estado del contacto en el que la plantilla de cada acción ya se envió. En
// los turnos siguientes no se repite: el LLM responde con normalidad.
const ESTADO_YA_INFORMADO = {
  archivar: 'no_calificado',
  ofrecer_agenda: 'calificado_pendiente_agendamiento',
};

function instruccionSiguientePaso(ctx, ev) {
  const etiquetas = new Map(ctx.rol.campos.map((c) => [c.clave, c.etiqueta]));
  switch (ev.accion) {
    case 'solicitar_datos': {
      const siguiente = (ev.campos_faltantes || [])[0];
      return siguiente
        ? `Pide solo el siguiente dato: ${etiquetas.get(siguiente) || siguiente}.`
        : 'Pide la información que falte para continuar.';
    }
    case 'verificar_direccion':
      return 'Confirma con la persona la ciudad, el barrio y la dirección completa del inmueble.';
    case 'reintentar_verificacion':
      return 'Informa que vas a revisar la dirección y que continúan en breve. No descartes a la persona ni pidas otra vez la dirección.';
    case 'ofrecer_agenda':
      return 'La persona ya calificó y ya se le informó que su información quedó registrada y que el horario aún no está reservado. Responde con cordialidad a lo que diga. Si pregunta por la cita, explica que el horario aún no está reservado. No pidas más datos, no inventes horarios ni digas que la cita está confirmada.';
    case 'archivar':
      return 'Ya se le informó a la persona que su caso no cumple las condiciones para continuar. Responde con cordialidad y brevedad a lo que diga. No expliques los criterios internos, no pidas más datos ni reabras la calificación.';
    default:
      return 'Continúa la conversación según tus reglas.';
  }
}

function solicitudRedaccion(ctx) {
  const ev = ctx.evaluacion || {};
  const sistema = rellenar(ctx.rol.prompt_sistema, {
    nombre_tenant: ctx.tenant.nombre,
    canal: NOMBRE_CANAL[ctx.canal.tipo] || ctx.canal.tipo,
  });
  const estado = [
    '## Estado de la conversación (lo calcula el sistema)',
    'El sistema ya registró los datos y evaluó la calificación en este turno; tú solo redactas el siguiente mensaje.',
    `- Ya te presentaste como asistente virtual: ${ctx.conversacion.identificado_como_virtual ? 'sí' : 'no'}.`,
    ctx.conversacion.identificado_como_virtual || !ctx.plantillas.inicio
      ? null
      : `- Preséntate como en esta plantilla, sin repetir preguntas ya respondidas: "${ctx.plantillas.inicio}"`,
    `- Datos registrados: ${JSON.stringify(ctx.contacto.datos || {})}`,
    `- Acción: ${ev.accion || 'ninguna'}. Campos faltantes: ${(ev.campos_faltantes || []).join(', ') || 'ninguno'}.`,
    `- Siguiente paso: ${instruccionSiguientePaso(ctx, ev)}`,
    'Responde solo con el texto del mensaje para la persona, sin comillas ni explicaciones.',
  ].filter(Boolean).join('\n');

  return {
    model: modelo(ctx),
    temperature: 0.4,
    messages: [{ role: 'system', content: `${sistema}\n\n${estado}` }, ...mensajesHistorial(ctx)],
  };
}

/**
 * Decide la respuesta del turno.
 * @returns {{ respuesta_fija: {texto, plantilla} | null, solicitud_llm: object | null, eventos: object[] }}
 */
function planificarRespuesta(ctx) {
  const p = ctx.plantillas || {};
  const fija = (clave, eventos = []) => ({ respuesta_fija: { texto: p[clave], plantilla: clave }, solicitud_llm: null, eventos });

  if (!ctx.rol) {
    if (p.seleccion_intencion) return fija('seleccion_intencion');
    return { respuesta_fija: { texto: RESPUESTA_SEGURA, plantilla: null }, solicitud_llm: null, eventos: [evento('error', null, 'planificar_respuesta', 'Falta la plantilla seleccion_intencion')] };
  }

  const ev = ctx.evaluacion || {};
  const clave = PLANTILLA_POR_ACCION[ev.accion];
  const yaInformado = ESTADO_YA_INFORMADO[ev.accion] && ctx.estado_anterior === ESTADO_YA_INFORMADO[ev.accion];
  if (clave && p[clave] && !yaInformado) {
    const eventos = ev.accion === 'ofrecer_agenda'
      ? [evento('advertencia', null, 'agendamiento', 'Contacto calificado: el calendario aún no está conectado al flujo; agendar manualmente', { contacto_id: ctx.contacto.id })]
      : [];
    return fija(clave, eventos);
  }
  return { respuesta_fija: null, solicitud_llm: solicitudRedaccion(ctx), eventos: [] };
}

function interpretarRedaccion(respuesta) {
  const r = contenidoOpenAI(respuesta);
  if (r.error) {
    return { texto: RESPUESTA_SEGURA, plantilla: null, eventos: [evento('error', 'openai', 'redactar_respuesta', r.error)] };
  }
  return { texto: r.contenido.replace(/^"(.*)"$/s, '$1'), plantilla: null, eventos: [] };
}

module.exports = {
  RESPUESTA_SEGURA,
  rellenar,
  solicitudClasificacion,
  interpretarClasificacion,
  solicitudExtraccion,
  interpretarExtraccion,
  evaluarTurno,
  planificarRespuesta,
  interpretarRedaccion,
};
