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
  return String(texto).replace(/\{\{(\w+)\}\}/g, (todo, clave) => (valores[clave] !== undefined && valores[clave] !== null ? valores[clave] : todo));
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

function modalidades(ctx) {
  const m = ctx.integraciones && ctx.integraciones.calendario && ctx.integraciones.calendario.modalidades;
  return m && typeof m === 'object' ? Object.keys(m) : [];
}

function solicitudExtraccion(ctx) {
  const agenda = ctx.conversacion.agenda || {};
  const conHorarios = Array.isArray(agenda.ofrecidos) && agenda.ofrecidos.length > 0;
  const sistema = [
    'Extraes datos de una conversación inmobiliaria. No conversas.',
    conHorarios
      ? 'Devuelve solo JSON con la forma {"datos": {...}, "seleccion": {...} | null}.'
      : 'Devuelve solo JSON con la forma {"datos": {...}}.',
    'Incluye únicamente claves de esta lista y solo valores que la persona dijo de forma explícita.',
    'Si la persona corrigió un dato, usa el valor más reciente. Omite lo que no sepas; nunca adivines.',
    'Campos:',
    ...ctx.rol.campos.map(describirCampo),
    '',
    `Datos ya registrados: ${JSON.stringify(ctx.contacto.datos || {})}`,
    ...(conHorarios ? [
      '',
      'Horarios que se le ofrecieron a la persona:',
      agenda.texto || agenda.ofrecidos.join('\n'),
      'Si en su ÚLTIMO mensaje la persona elige uno de estos horarios, incluye',
      `"seleccion": {"horario": <número de la lista>, "modalidad": <una de: ${modalidades(ctx).join(', ') || 'llamada'}, o null si no la menciona>}.`,
      'Si no eligió un horario de la lista, o es ambiguo, usa "seleccion": null.',
    ] : []),
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
    return { datos: {}, seleccion: null, eventos: [evento('error', 'openai', 'extraer_datos', r.error)] };
  }
  const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const datos = r.json && esObjeto(r.json.datos) ? r.json.datos : {};
  const seleccion = r.json && esObjeto(r.json.seleccion) ? r.json.seleccion : null;
  return { datos, seleccion, eventos: [] };
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
};

// Estado del contacto en el que la plantilla de cada acción ya se envió. En
// los turnos siguientes no se repite: el LLM responde con normalidad.
const ESTADO_YA_INFORMADO = {
  archivar: 'no_calificado',
};

// Resultado del agendamiento en este turno (app.registrar_oferta / registrar_cita).
const PLANTILLA_POR_RESULTADO_AGENDA = {
  ofrecidos: 'calificado',
  agotado: 'horario_agotado',
  confirmada: 'confirmacion',
  sin_disponibilidad: 'falla_agenda',
  error: 'falla_agenda',
};

function instruccionAgenda(ctx) {
  const agenda = ctx.conversacion.agenda || {};
  const cita = ctx.cita;
  if (ctx.resultado_agenda && ctx.resultado_agenda.tipo === 'pendiente_confirmacion') {
    return 'La reserva se registró, pero el calendario debe confirmarla. Informa que la solicitud de cita quedó registrada y que recibirá la confirmación por este medio. No digas que está confirmada.';
  }
  if (cita && cita.estado === 'confirmada') {
    return `La persona ya tiene una cita confirmada (${cita.inicio}, ${ctx.tenant.zona_horaria}, modalidad ${cita.modalidad}). Responde con cordialidad a lo que diga. No agendes otra cita ni cambies la existente; si quiere cambiarla, indica que el asesor la atenderá.`;
  }
  if (cita && cita.estado === 'seleccion_pendiente') {
    return 'La solicitud de cita está pendiente de confirmación del calendario. Responde con cordialidad; no digas que está confirmada.';
  }
  if (Array.isArray(agenda.ofrecidos) && agenda.ofrecidos.length) {
    return `La persona ya calificó y debe elegir un horario. Pídele que responda con el número del horario que prefiere de esta lista, sin inventar otros:\n${agenda.texto}`;
  }
  return 'La persona ya calificó. Indica que el siguiente paso es reservar con un asesor. No inventes horarios ni digas que la cita está confirmada.';
}

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
      return instruccionAgenda(ctx);
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
  const fija = (clave, eventos = [], valores = {}) => ({ respuesta_fija: { texto: rellenar(p[clave], valores), plantilla: clave }, solicitud_llm: null, eventos });

  if (!ctx.rol) {
    if (p.seleccion_intencion) return fija('seleccion_intencion');
    return { respuesta_fija: { texto: RESPUESTA_SEGURA, plantilla: null }, solicitud_llm: null, eventos: [evento('error', null, 'planificar_respuesta', 'Falta la plantilla seleccion_intencion')] };
  }

  const ra = ctx.resultado_agenda;
  const claveAgenda = ra && PLANTILLA_POR_RESULTADO_AGENDA[ra.tipo];
  if (claveAgenda && p[claveAgenda]) {
    return fija(claveAgenda, [], {
      horarios_disponibles: ra.texto,
      horarios_alternativos: ra.texto,
      fecha: ra.fecha,
      hora: ra.hora,
      zona_horaria: ra.zona_texto || ra.zona_horaria,
      modalidad: ra.modalidad,
    });
  }

  const ev = ctx.evaluacion || {};
  const clave = PLANTILLA_POR_ACCION[ev.accion];
  const yaInformado = ESTADO_YA_INFORMADO[ev.accion] && ctx.estado_anterior === ESTADO_YA_INFORMADO[ev.accion];
  if (clave && p[clave] && !yaInformado) {
    return fija(clave);
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
