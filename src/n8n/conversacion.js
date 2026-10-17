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

// --- Nombre --------------------------------------------------------------------------

const NOMBRES_GENERICOS = new Set([
  'cliente', 'usuario', 'contacto', 'vip', 'admin', 'info', 'ventas', 'inmobiliaria', 'test', 'prueba',
  'whatsapp', 'null', 'undefined', 'sin', 'nombre',
]);
const TRATAMIENTOS = new Set(['sr', 'sra', 'srta', 'señor', 'senor', 'señora', 'senora', 'don', 'doña', 'dona', 'dr', 'dra', 'ing', 'lic', 'arq']);

const capitalizar = (p) => p.charAt(0).toLocaleUpperCase('es') + p.slice(1).toLocaleLowerCase('es');

/**
 * Primer nombre utilizable de un nombre (p. ej. el del perfil de WhatsApp), o
 * null si no parece el nombre de una persona: vacío, con números, genérico,
 * solo iniciales o sin letras. Omite tratamientos ("Dr.", "Sra.").
 */
function primerNombre(nombre) {
  if (typeof nombre !== 'string' || /\d/.test(nombre)) return null;
  const palabras = nombre.replace(/[^\p{L}\s'.-]/gu, ' ').split(/\s+/).filter(Boolean);
  if (palabras.some((w) => NOMBRES_GENERICOS.has(w.toLowerCase()))) return null;
  const sinTratamiento = palabras.filter((w, i) => i > 0 || !TRATAMIENTOS.has(w.toLowerCase().replace(/\.$/, '')));
  const resto = sinTratamiento.length < palabras.length ? sinTratamiento : palabras;
  const primera = (resto[0] || '').replace(/^[.'-]+|[.'-]+$/g, '');
  if (primera.includes('.') || primera.replace(/[^\p{L}]/gu, '').length < 2) return null;
  if (TRATAMIENTOS.has(primera.toLowerCase())) return null;
  return primera.split('-').map(capitalizar).join('-');
}

function nombreParaDirigirse(ctx) {
  return primerNombre((ctx.contacto.datos || {}).nombre) || primerNombre(ctx.contacto.nombre);
}

function valoresPrompt(ctx) {
  const comercial = (ctx.tenant.parametros && ctx.tenant.parametros.comercial) || {};
  return {
    nombre_tenant: ctx.tenant.nombre,
    canal: NOMBRE_CANAL[ctx.canal.tipo] || ctx.canal.tipo,
    asesor: comercial.asesor || 'un asesor',
    argumento_exclusividad: comercial.argumento_exclusividad || '',
    ciudades_cobertura: listaHumana(((ctx.tenant.parametros || {}).cobertura || {}).ciudades || []) || 'su zona de cobertura',
    propuesta: textoPropuesta(comercial.propuesta, comercial.asesor || 'el asesor'),
  };
}

/** A nombre de quién se presenta la asistente: parametros.comercial.asesor_nombre_completo o la marca. */
function representado(ctx) {
  const c = (ctx.tenant.parametros && ctx.tenant.parametros.comercial) || {};
  return c.asesor_nombre_completo || ctx.tenant.nombre;
}

function listaHumana(items) {
  const l = items.filter(Boolean);
  return l.length <= 1 ? (l[0] || '') : `${l.slice(0, -1).join(', ')} y ${l.at(-1)}`;
}

/** Propuesta comercial aprobada (parametros.comercial.propuesta) en una o dos frases. */
function textoPropuesta(p, asesor) {
  if (!p) return 'aún no hay una propuesta aprobada; si preguntan por condiciones, explica que las aclara el asesor.';
  const partes = [];
  if (p.exclusiva) partes.push(`${asesor} trabaja la propiedad en exclusiva`);
  if (typeof p.comision_pct === 'number') partes.push(`con una comisión del ${p.comision_pct} %`);
  const beneficios = (p.beneficios || []).filter(Boolean);
  return `${partes.join(' ') || `${asesor} explica sus condiciones en la llamada`}.${beneficios.length ? ` Beneficios aprobados: ${beneficios.join('; ')}.` : ''}`;
}

function mensajesHistorial(ctx, { soloCasoActual = false } = {}) {
  let historial = (ctx.historial || []).slice(-MENSAJES_EN_CONTEXTO);
  // Con casos anteriores, la extracción lee solo desde que empezó el actual (más
  // la última pregunta y respuesta), para no mezclar datos de otra propiedad.
  const desde = soloCasoActual && ctx.oportunidad && ctx.oportunidad.anteriores > 0 && ctx.oportunidad.creada_en;
  if (desde) {
    const t = new Date(desde).getTime();
    const delCaso = historial.filter((m) => m.creado_en && new Date(m.creado_en).getTime() >= t);
    historial = delCaso.length >= 2 ? delCaso : historial.slice(-2);
  }
  return historial.map((m) => ({ role: m.direccion === 'entrante' ? 'user' : 'assistant', content: m.contenido }));
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

const CAMPOS_DE_LA_PERSONA = new Set(['nombre', 'telefono', 'email']);

// Necesidad que atiende la otra asistente: el sistema cambia de rol (app.cambiar_rol).
const CAMBIO_INTENCION = {
  lucia: { valor: 'comprar', instruccion: 'Si en su ÚLTIMO mensaje la persona dice que en realidad quiere comprar o tomar en arriendo una propiedad (no vender ni ofrecer la suya), agrega "cambio_intencion": "comprar".' },
  sonia: { valor: 'vender', instruccion: 'Si en su ÚLTIMO mensaje la persona dice que en realidad quiere vender u ofrecer en arriendo una propiedad suya (no comprar ni buscar), agrega "cambio_intencion": "vender".' },
};

/** El caso actual ya tiene datos de una propiedad (o búsqueda) o ya se evaluó. */
function tienePropiedad(ctx) {
  const datos = ctx.contacto.datos || {};
  return Object.keys(datos).some((k) => !CAMPOS_DE_LA_PERSONA.has(k))
    || !['en_calificacion', 'informacion_incompleta'].includes(ctx.contacto.estado);
}

function solicitudExtraccion(ctx) {
  const agenda = ctx.conversacion.agenda || {};
  const conHorarios = Array.isArray(agenda.ofrecidos) && agenda.ofrecidos.length > 0;
  const sistema = [
    'Extraes datos de una conversación inmobiliaria. No conversas.',
    conHorarios
      ? 'Devuelve solo JSON con la forma {"datos": {...}, "seleccion": {...} | null}.'
      : 'Devuelve solo JSON con la forma {"datos": {...}}.',
    'Puedes agregar "nueva_propiedad", "misma_cita" y "cambio_intencion" solo en los casos que se indican abajo.',
    'Incluye únicamente claves de esta lista y solo valores que la persona dijo de forma explícita.',
    'Si la persona corrigió un dato, usa el valor más reciente. Omite lo que no sepas; nunca adivines.',
    ...(tienePropiedad(ctx) ? [
      `Ya hay ${ctx.rol.codigo === 'sonia' ? 'una búsqueda registrada' : 'una propiedad registrada'}: son los datos ya registrados de abajo.`,
      'Si en su ÚLTIMO mensaje la persona presenta OTRA propiedad distinta (otro inmueble para vender o arrendar, u otra búsqueda), agrega "nueva_propiedad": true y en "datos" incluye solo lo que dijo de esa nueva propiedad. Si solo responde a tus preguntas sobre la propiedad de la que ya se está hablando, no lo agregues.',
      'Si solo corrige o completa un dato de la misma propiedad, no agregues "nueva_propiedad".',
    ] : []),
    ...(CAMBIO_INTENCION[ctx.rol.codigo] ? [
      CAMBIO_INTENCION[ctx.rol.codigo].instruccion,
    ] : []),
    ...(tienePropiedad(ctx) || (ctx.oportunidad && ctx.oportunidad.anteriores > 0) ? [
      'Si la persona pide de forma explícita que esta propiedad se revise en la reunión o cita que ya tiene agendada, agrega "misma_cita": true.',
    ] : []),
    'Campos:',
    ...ctx.rol.campos.map(describirCampo),
    '',
    `Datos ya registrados: ${JSON.stringify(ctx.contacto.datos || {})}`,
    ...(!(ctx.contacto.datos || {}).nombre && primerNombre(ctx.contacto.nombre)
      ? [`Nombre del perfil de ${NOMBRE_CANAL[ctx.canal.tipo] || 'la red'}: "${ctx.contacto.nombre}". Si la persona no dio otro nombre ni lo contradijo, úsalo como "nombre".`]
      : []),
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
    messages: [{ role: 'system', content: sistema }, ...mensajesHistorial(ctx, { soloCasoActual: true })],
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
  const nueva_propiedad = Boolean(r.json && r.json.nueva_propiedad === true);
  const misma_cita = Boolean(r.json && r.json.misma_cita === true);
  const cambio_intencion = r.json && ['comprar', 'vender'].includes(r.json.cambio_intencion) ? r.json.cambio_intencion : null;
  return { datos, seleccion, nueva_propiedad, misma_cita, cambio_intencion, eventos: [] };
}

// --- Evaluación ----------------------------------------------------------------------

/** Ejecuta el evaluador determinista con la configuración del rol. */
function evaluarTurno(ctx, evaluarCalificacion) {
  try {
    const evaluacion = evaluarCalificacion({
      criterios: ctx.rol.criterios,
      requiereVerificacionDireccion: ctx.rol.requiere_verificacion_direccion,
      datos: ctx.contacto.datos,
      verificacionDireccion: ctx.verificacion,
      parametros: ctx.tenant.parametros || {},
    });
    // Una propiedad que se revisa en una reunión ya agendada no se nutre: va a esa reunión.
    if (evaluacion.resultado === 'calificado' && ctx.oportunidad && ctx.oportunidad.cita_compartida) {
      evaluacion.accion = 'ofrecer_agenda';
    }
    exigirPalabrasMinimas(ctx, evaluacion);
    // Antes de ofrecer horarios, la persona conoce la propuesta y dice que quiere continuar.
    if (evaluacion.accion === 'ofrecer_agenda' && pidePropuesta(ctx) && (ctx.contacto.datos || {}).desea_continuar !== true) {
      evaluacion.accion = 'presentar_propuesta';
    }
    return { evaluacion, eventos: [] };
  } catch (e) {
    // Configuración inválida: no se califica ni se descarta a nadie.
    return {
      evaluacion: { resultado: 'informacion_incompleta', accion: 'solicitar_datos', campos_faltantes: [], reglas: [], motivo: e.message, codigo_motivo: 'error_configuracion' },
      eventos: [evento('error', null, 'evaluar_calificacion', e.message)],
    };
  }
}

const ESTADOS_CON_CITA = new Set(['seleccion_pendiente_confirmacion', 'cita_confirmada', 'entregado_asesor', 'cita_reprogramada', 'atencion_comercial_iniciada']);

const tieneCampo = (ctx, clave) => (ctx.rol.campos || []).some((c) => c.clave === clave);

/** El rol presenta la propuesta antes de agendar (campo desea_continuar), salvo que ya haya cita. */
function pidePropuesta(ctx) {
  return tieneCampo(ctx, 'desea_continuar')
    && !(ctx.oportunidad && ctx.oportunidad.cita_compartida)
    && !ctx.cita
    && !ESTADOS_CON_CITA.has(ctx.contacto.estado);
}

/** Campo obligatorio con palabras_minimas (p. ej. nombre completo): con menos palabras, falta. */
function exigirPalabrasMinimas(ctx, ev) {
  if (ev.resultado === 'no_calificado') return;
  const obligatorios = ((ctx.rol.criterios || {}).campos_obligatorios || []).map((c) => (typeof c === 'string' ? c : c.campo));
  const cortos = (ctx.rol.campos || []).filter((c) => c.palabras_minimas && obligatorios.includes(c.clave)).filter((c) => {
    const v = (ctx.contacto.datos || {})[c.clave];
    return typeof v === 'string' && v.trim() && v.trim().split(/\s+/).length < c.palabras_minimas;
  }).map((c) => c.clave);
  if (!cortos.length) return;
  const faltan = new Set([...(ev.campos_faltantes || []), ...cortos]);
  ev.campos_faltantes = obligatorios.filter((c) => faltan.has(c));
  if (ev.resultado === 'calificado') {
    Object.assign(ev, { resultado: 'informacion_incompleta', accion: 'solicitar_datos', prioridad: null, codigo_motivo: 'campos_faltantes', motivo: `Faltan campos obligatorios: ${ev.campos_faltantes.join(', ')}` });
  }
}

// --- Respuesta ----------------------------------------------------------------------

const PLANTILLA_POR_ACCION = {
  archivar: 'no_calificado',
  aclarar_direccion: 'direccion_ambigua',
  nutrir: 'prioridad_baja',
};

// Estado del contacto en el que la plantilla de cada acción ya se envió. En
// los turnos siguientes no se repite: el LLM responde con normalidad.
const ESTADO_YA_INFORMADO = {
  archivar: 'no_calificado',
  nutrir: 'nutricion',
};

/** Nombre del encuentro y quién contacta a quién, según la modalidad (parametros.agenda.encuentros). */
function encuentroDe(ctx, modalidad) {
  const e = ((((ctx.tenant.parametros || {}).agenda || {}).encuentros || {})[modalidad]) || {};
  const asesor = valoresPrompt(ctx).asesor;
  return {
    nombre: e.nombre || `tu ${modalidad || 'reunión'}`,
    quien_contacta: rellenar(e.quien_contacta || '', { asesor }),
  };
}

/**
 * La propuesta se presenta la primera vez con la plantilla fija (texto
 * aprobado); si ya se envió, el agente responde las dudas (instruccionPropuesta).
 */
function planPropuesta(ctx, ev, fija) {
  const p = ctx.plantillas || {};
  const datos = ctx.contacto.datos || {};
  if (ev.accion !== 'presentar_propuesta' || datos.desea_continuar === false || !p.propuesta) return null;
  const comercial = (ctx.tenant.parametros && ctx.tenant.parametros.comercial) || {};
  const pct = comercial.propuesta && comercial.propuesta.comision_pct;
  if (typeof pct !== 'number') return null;
  const nombre = nombreParaDirigirse(ctx);
  const plan = fija('propuesta', [], { nombre, comision_pct: String(pct).replace('.', ',') });
  if (!nombre) plan.respuesta_fija.texto = plan.respuesta_fija.texto.replace(/,\s*\{\{nombre\}\}/, '');
  const yaEnviada = (ctx.historial || []).some((m) => m.direccion === 'saliente' && m.contenido === plan.respuesta_fija.texto);
  return yaEnviada ? null : plan;
}

function ultimoMensajeDelAgente(ctx) {
  const salientes = (ctx.historial || []).filter((m) => m.direccion === 'saliente');
  return salientes.length ? salientes[salientes.length - 1].contenido : null;
}

function nutreNoCalificados(ctx) {
  const n = ctx.tenant.parametros && ctx.tenant.parametros.nutricion;
  return Boolean(n && n.incluir_no_calificados);
}

/** Dossier del rol en los parámetros del tenant: { url, nombre_archivo } o null. */
function dossier(ctx) {
  const d = ctx.tenant.parametros && ctx.tenant.parametros.dossier && ctx.tenant.parametros.dossier[ctx.rol.codigo];
  return d && typeof d.url === 'string' && /^https:\/\//.test(d.url) ? { url: d.url, nombre_archivo: d.nombre_archivo || 'informacion.pdf' } : null;
}

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
  const compartida = ctx.oportunidad && ctx.oportunidad.cita_compartida;
  if (compartida) {
    return `Esta propiedad se revisará en la reunión que la persona ya tiene agendada con ${valoresPrompt(ctx).asesor} el ${fechaYHora(compartida.inicio, ctx.tenant.zona_horaria)}. Confírmaselo en una frase. No ofrezcas horarios ni agendes otra cita.`;
  }
  if (ctx.resultado_agenda && ctx.resultado_agenda.tipo === 'pendiente_confirmacion') {
    return 'La reserva se registró, pero el calendario debe confirmarla. Informa que la solicitud de cita quedó registrada y que recibirá la confirmación por este medio. No digas que está confirmada.';
  }
  if (cita && cita.estado === 'confirmada' && new Date(cita.inicio) > new Date()) {
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

/**
 * Al empezar, Lucía pide permiso antes de las preguntas (campo acepta_preguntas).
 * Solo en los primeros mensajes: si la persona ya dio datos o siguió la
 * conversación, no se vuelve a pedir.
 */
function instruccionPermiso(ctx) {
  if (!tieneCampo(ctx, 'acepta_preguntas') || ctx.retorno) return null;
  const acepta = (ctx.contacto.datos || {}).acepta_preguntas;
  if (acepta === false) {
    return 'La persona dijo que ahora no tiene tiempo: respétalo, dile que puede escribir cuando le resulte conveniente para retomar y no hagas preguntas.';
  }
  const entrantes = (ctx.historial || []).filter((m) => m.direccion === 'entrante').length;
  if (acepta === undefined && entrantes <= 2) {
    return 'Pide permiso para hacerle unas preguntas breves sobre su propiedad, como en la plantilla de presentación, con una sola pregunta. No pidas ningún dato todavía; si ya contó algo, reconócelo.';
  }
  return null;
}

const fueraDeCobertura = (ev) => String(ev.codigo_motivo || '').split(',').includes('cobertura_ciudad');

function instruccionReferencia(ctx) {
  const datos = ctx.contacto.datos || {};
  const cierre = 'Pregunta si necesita alguna aclaración. No ofrezcas una llamada con el asesor, no digas que hay un agente disponible ni que alguien la contactará.';
  if (datos.autoriza_referencia === true) {
    return `La persona autorizó compartir sus datos para una posible referencia. Agradécele y explica que consultarán si cuentan con un colega en esa zona y que, si encuentran una opción, podrán gestionar la referencia. ${cierre}`;
  }
  if (datos.autoriza_referencia === false) {
    return `La persona no autorizó compartir sus datos: respétalo y confírmale que no se compartirán. ${cierre}`;
  }
  return `La propiedad está fuera de la cobertura directa (${valoresPrompt(ctx).ciudades_cobertura}). Responde con cordialidad a lo que diga y pregúntale si autoriza compartir sus datos de contacto y la información de la propiedad para gestionar una posible referencia con un colega de la zona. ${cierre}`;
}

function instruccionPropuesta(ctx) {
  const v = valoresPrompt(ctx);
  const datos = ctx.contacto.datos || {};
  if (datos.desea_continuar === false) {
    return 'La persona prefirió no avanzar por ahora: respétalo sin insistir, dile que puede escribir cuando quiera retomar y no ofrezcas horarios.';
  }
  return [
    'La persona cumple los criterios. Antes de ofrecer horarios debe entender cómo trabaja el asesor y decir que quiere continuar.',
    `Si aún no lo explicaste en esta conversación, explícalo en dos frases: ${v.propuesta} No garantices precio ni plazo de venta.`,
    'Si ya lo explicaste, responde sus dudas solo con esa información; si algo requiere el criterio del asesor, di que lo registras y que él lo aclarará.',
    'No menciones beneficios que no estén en la propuesta ni comentes qué está o no aprobado.',
    datos.solicita_acuerdo === true ? 'Pidió el borrador del acuerdo: no está disponible por este medio; dile que registras la solicitud y que el asesor lo revisa con ella.' : null,
    'Termina con una sola pregunta: "¿Hay algún punto que quieras aclarar antes de continuar?" o, si ya resolviste sus dudas, si desea continuar para agendar una llamada con el asesor.',
    'No ofrezcas horarios en este mensaje.',
  ].filter(Boolean).join(' ').replace(/el asesor/g, v.asesor);
}

function instruccionSiguientePaso(ctx, ev) {
  const etiquetas = new Map(ctx.rol.campos.map((c) => [c.clave, c.etiqueta]));
  switch (ev.accion) {
    case 'solicitar_datos': {
      const permiso = instruccionPermiso(ctx);
      if (permiso) return permiso;
      const siguiente = (ev.campos_faltantes || [])[0];
      if (siguiente === 'nombre' && (ctx.contacto.datos || {}).nombre) {
        return 'Pide su nombre completo con esta frase: "¿Me puedes facilitar tu nombre completo, por favor?"';
      }
      return siguiente
        ? `Pide solo el siguiente dato: ${etiquetas.get(siguiente) || siguiente}.`
        : 'Pide la información que falte para continuar.';
    }
    case 'presentar_propuesta':
      return instruccionPropuesta(ctx);
    case 'verificar_direccion':
      return 'Confirma con la persona la ciudad, el barrio y la dirección completa del inmueble.';
    case 'aclarar_direccion': {
      const sugerida = ctx.verificacion && ctx.verificacion.direccion_normalizada;
      return [
        'La dirección todavía no se pudo ubicar con precisión y ya se lo dijiste: no repitas ese mensaje.',
        sugerida ? `Google encontró "${sugerida}": pregúntale en una frase si esa es la dirección del inmueble y en qué barrio queda.` : 'Pídele una aclaración concreta: el número exacto de la calle o carrera, o un punto de referencia cercano.',
        'Si la persona habló de otra cosa, respóndele brevemente y retoma la dirección.',
      ].join(' ');
    }
    case 'reintentar_verificacion':
      return 'Informa que vas a revisar la dirección y que continúan en breve. No descartes a la persona ni pidas otra vez la dirección.';
    case 'ofrecer_agenda':
      return instruccionAgenda(ctx);
    case 'archivar':
      if (fueraDeCobertura(ev)) return instruccionReferencia(ctx);
      return 'Ya se le informó a la persona que su caso no cumple las condiciones para continuar. Responde con cordialidad y brevedad a lo que diga. No expliques los criterios internos, no pidas más datos ni reabras la calificación.';
    case 'nutrir':
      return 'La persona cumple los criterios pero no tiene prisa; ya se le informó que quedó registrada. Responde con cordialidad y brevedad a lo que diga. No ofrezcas ni agendes citas ni horarios. Si dice que ahora sí quiere avanzar pronto, pregúntale en cuánto tiempo quiere concretar.';
    default:
      return 'Continúa la conversación según tus reglas.';
  }
}

// --- Retorno tras días sin contacto -----------------------------------------------------

const ESTADOS_AGENDA_PENDIENTE = new Set([
  'calificado_pendiente_agendamiento', 'seleccion_pendiente_confirmacion', 'sin_disponibilidad', 'error_agendamiento',
]);

function fechaYHora(iso, zona) {
  const opciones = { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat('es-CO', opciones).format(new Date(iso)).replace(/[\u00a0\u202f]/g, ' ');
}

/**
 * Lo que quedó pendiente con quien regresa, calculado del estado y no del
 * LLM, o null si no hay nada que retomar (no calificado, cita ya pasada).
 */
function temaAbierto(ctx) {
  const asesor = valoresPrompt(ctx).asesor;
  const ahora = new Date((ctx.retorno && ctx.retorno.ahora) || Date.now());
  const cita = ctx.cita;
  if (cita && new Date(cita.inicio) > ahora) {
    if (cita.estado === 'seleccion_pendiente') return 'su solicitud de cita está pendiente de confirmación';
    if (['confirmada', 'reprogramada'].includes(cita.estado)) {
      return `tiene una reunión con ${asesor} el ${fechaYHora(cita.inicio, ctx.tenant.zona_horaria)}`;
    }
  }
  const estado = ctx.contacto.estado;
  if (ESTADOS_AGENDA_PENDIENTE.has(estado)) return `quedó pendiente agendar la reunión con ${asesor}`;
  if (estado === 'nutricion') {
    const plazo = Number((ctx.contacto.datos || {}).plazo_meses || (ctx.contacto.datos || {}).horizonte_compra_meses);
    return plazo > 0 ? `nos contó que pensaba concretar en unos ${plazo} meses` : 'quedó en avisarnos cuando quisiera avanzar';
  }
  if (['en_calificacion', 'informacion_incompleta'].includes(estado) && Object.keys(ctx.contacto.datos || {}).length > 1) {
    return ctx.rol.codigo === 'lucia'
      ? 'quedaron pendientes unos datos de su propiedad'
      : 'quedaron pendientes unos datos de lo que busca';
  }
  return null;
}

function instruccionRetorno(ctx) {
  const horas = Number(ctx.retorno.horas_sin_contacto) || 0;
  const tiempo = horas >= 48 ? `${Math.floor(horas / 24)} días` : `${horas} horas`;
  const tema = temaAbierto(ctx);
  return [
    `La persona vuelve a escribir después de ${tiempo} sin contacto. En un solo mensaje, de máximo dos frases:`,
    '1) salúdala con cordialidad por su nombre y dile que es un gusto saludarla de nuevo;',
    tema
      ? `2) recuérdale en pocas palabras lo que quedó pendiente: ${tema};`
      : '2) no menciones detalles de la conversación anterior;',
    '3) termina preguntándole en qué la puedes ayudar hoy.',
    'Si en su mensaje ya dijo qué necesita, no hagas esa pregunta: retoma lo que pidió. No ofrezcas horarios en este mensaje.',
  ].join(' ');
}

function solicitudRedaccion(ctx) {
  const ev = ctx.evaluacion || {};
  const sistema = rellenar(ctx.rol.prompt_sistema, valoresPrompt(ctx));
  const nombre = nombreParaDirigirse(ctx);
  const estado = [
    '## Estado de la conversación (lo calcula el sistema)',
    'El sistema ya registró los datos y evaluó la calificación en este turno; tú solo redactas el siguiente mensaje.',
    `- Ya te presentaste como asistente virtual: ${ctx.conversacion.identificado_como_virtual ? 'sí' : 'no'}.`,
    ctx.conversacion.identificado_como_virtual || !ctx.plantillas.inicio
      ? null
      : ctx.retorno
        ? `- Preséntate en pocas palabras como ${ctx.rol.nombre_visible}, asistente virtual de ${representado(ctx)}.`
        : `- Preséntate como en esta plantilla, sin repetir preguntas ya respondidas: "${ctx.plantillas.inicio}". Si la plantilla termina en una pregunta distinta del siguiente paso, omítela: haz una sola pregunta.`,
    nombre
      ? `- Dirígete a la persona como "${nombre}". No le preguntes su nombre.`
      : '- Aún no sabes cómo se llama la persona: si el siguiente dato no es otro, pregúntale su nombre de forma natural.',
    `- Datos registrados: ${JSON.stringify(ctx.contacto.datos || {})}`,
    ctx.oportunidad && ctx.oportunidad.rol_anterior && ctx.oportunidad.rol_anterior !== ctx.rol.codigo
      ? `- La persona venía hablando con otra asistente sobre otra necesidad y ahora la atiendes tú. Si aún no lo hiciste, preséntate en una frase como ${ctx.rol.nombre_visible}, asistente virtual de ${representado(ctx)}, y continúa con el siguiente paso.`
      : null,
    ctx.oportunidad && ctx.oportunidad.anteriores > 0
      ? '- La persona ya tuvo otro caso con nosotros (otra propiedad o búsqueda). Los datos registrados son solo los de este caso: no los mezcles con lo hablado antes ni digas que una dirección nueva ya está registrada.'
      : null,
    `- Acción: ${ev.accion || 'ninguna'}. Campos faltantes: ${(ev.campos_faltantes || []).join(', ') || 'ninguno'}.`,
    `- Siguiente paso: ${ctx.retorno ? instruccionRetorno(ctx) : instruccionSiguientePaso(ctx, ev)}`,
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
  const comunes = ctx.rol || ctx.tenant ? { asesor: valoresPrompt(ctx).asesor, ciudades_cobertura: valoresPrompt(ctx).ciudades_cobertura } : {};
  const fija = (clave, eventos = [], valores = {}) => ({ respuesta_fija: { texto: rellenar(p[clave], { ...comunes, ...valores }), plantilla: clave }, solicitud_llm: null, eventos });

  if (!ctx.rol) {
    if (p.seleccion_intencion) return fija('seleccion_intencion');
    return { respuesta_fija: { texto: RESPUESTA_SEGURA, plantilla: null }, solicitud_llm: null, eventos: [evento('error', null, 'planificar_respuesta', 'Falta la plantilla seleccion_intencion')] };
  }

  // Quien regresa tras días sin escribir recibe un saludo redactado, no una plantilla.
  // El primer mensaje del rol también se redacta: saluda, se presenta y, si aplica, pide permiso.
  if (ctx.retorno || !ctx.conversacion.identificado_como_virtual) {
    return { respuesta_fija: null, solicitud_llm: solicitudRedaccion(ctx), eventos: [] };
  }

  const ra = ctx.resultado_agenda;
  const claveAgenda = ra && PLANTILLA_POR_RESULTADO_AGENDA[ra.tipo];
  if (claveAgenda && p[claveAgenda]) {
    const encuentro = encuentroDe(ctx, ra.modalidad);
    return fija(claveAgenda, [], {
      encuentro: encuentro.nombre,
      quien_contacta: encuentro.quien_contacta,
      horarios_disponibles: ra.texto,
      horarios_alternativos: ra.texto,
      fecha: ra.fecha,
      hora: ra.hora,
      zona_horaria: ra.zona_texto || ra.zona_horaria,
      modalidad: ra.modalidad,
    });
  }

  const ev = ctx.evaluacion || {};
  const propuesta = planPropuesta(ctx, ev, fija);
  if (propuesta) return propuesta;
  const clave = PLANTILLA_POR_ACCION[ev.accion];
  const yaInformado = (ESTADO_YA_INFORMADO[ev.accion] && ctx.estado_anterior === ESTADO_YA_INFORMADO[ev.accion])
    // La dirección imprecisa se avisa con la plantilla una vez; después, aclaración redactada.
    || (ev.accion === 'aclarar_direccion' && ultimoMensajeDelAgente(ctx) === p[clave]);
  if (clave && p[clave] && !yaInformado) {
    // No calificados: si el tenant los nutre, mensaje cordial + dossier en vez de solo "no cumples".
    if (ev.accion === 'archivar' && fueraDeCobertura(ev) && p.fuera_cobertura) return fija('fuera_cobertura');
    const nutrirNoCalificado = ev.accion === 'archivar' && nutreNoCalificados(ctx) && p.no_calificado_nutricion;
    const plan = fija(nutrirNoCalificado ? 'no_calificado_nutricion' : clave);
    if ((ev.accion === 'nutrir' || nutrirNoCalificado) && dossier(ctx)) plan.respuesta_fija.documento = dossier(ctx);
    return plan;
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
  primerNombre,
  temaAbierto,
  rellenar,
  solicitudClasificacion,
  interpretarClasificacion,
  solicitudExtraccion,
  interpretarExtraccion,
  evaluarTurno,
  planificarRespuesta,
  interpretarRedaccion,
};
