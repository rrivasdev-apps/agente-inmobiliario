'use strict';

/**
 * Integración con GoHighLevel (API v2): contactos y calendario nativo.
 *
 * Funciones puras: construyen solicitudes HTTP e interpretan respuestas, sin
 * hacer llamadas de red. n8n ejecuta la solicitud (nodo HTTP Request) y pasa
 * la respuesta a estas funciones. Así la lógica se prueba sin credenciales y
 * el mismo código sirve para todos los tenants.
 *
 * Referencia: especificación OpenAPI oficial
 * https://github.com/GoHighLevel/highlevel-api-docs (apps/calendars.json,
 * apps/contacts.json).
 */

const URL_BASE = 'https://services.leadconnectorhq.com';

// Cada grupo de endpoints exige su propia versión en la cabecera Version.
const VERSION = Object.freeze({
  calendarios: '2021-04-15',
  contactos: '2021-07-28',
});

const MAX_DIAS_CONSULTA = 31; // límite de /free-slots
const MS_DIA = 24 * 60 * 60 * 1000;

// appointmentStatus de GoHighLevel -> app.estado_cita
const ESTADO_CITA = Object.freeze({
  new: 'seleccion_pendiente',     // reservada pero sin confirmar en el calendario
  confirmed: 'confirmada',
  active: 'confirmada',
  showed: 'confirmada',
  completed: 'confirmada',
  noshow: 'confirmada',
  cancelled: 'cancelada',
  invalid: 'cancelada',
});

function exigir(valor, nombre) {
  if (valor === undefined || valor === null || valor === '' || String(valor).startsWith('PENDIENTE')) {
    throw new Error(`Falta configurar ${nombre}`);
  }
  return valor;
}

function aFecha(valor, nombre) {
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) throw new Error(`${nombre} no es una fecha válida: ${valor}`);
  return d;
}

function cabeceras(version) {
  // El token no se incluye: lo agrega la credencial de n8n
  // (Header Auth: "Authorization: Bearer <Private Integration Token>").
  return { Accept: 'application/json', Version: version };
}

// -----------------------------------------------------------------------------
// Contactos
// -----------------------------------------------------------------------------

/**
 * Crea o actualiza el contacto calificado en la subcuenta (AC 22, 23, 24).
 * La deduplicación la aplica GoHighLevel según la opción "Allow Duplicate
 * Contact" de la subcuenta, que debe priorizar teléfono y luego correo.
 *
 * No envía assignedTo: registrar el contacto no lo asigna al asesor (AC 26).
 */
function solicitudUpsertContacto({ config, contacto, rol }) {
  const datos = contacto.datos || {};
  const cuerpo = {
    locationId: exigir(config.location_id, 'location_id de GoHighLevel'),
    name: contacto.nombre || datos.nombre || undefined,
    phone: contacto.telefono || undefined,
    email: contacto.email || undefined,
    tags: [exigir(rol.etiqueta_crm, 'etiqueta_crm del rol'), `canal-${contacto.canal_origen}`],
    source: `agente-${rol.codigo}`,
  };
  if (!cuerpo.phone && !cuerpo.email) {
    throw new Error('El contacto necesita teléfono o correo para registrarse en GoHighLevel');
  }
  if (rol.codigo === 'lucia') {
    cuerpo.address1 = datos.direccion_normalizada || datos.direccion || undefined;
    cuerpo.city = datos.ciudad || undefined;
  }
  return {
    metodo: 'POST',
    url: `${URL_BASE}/contacts/upsert`,
    cabeceras: cabeceras(VERSION.contactos),
    cuerpo: JSON.parse(JSON.stringify(cuerpo)), // quita los undefined
  };
}

function interpretarUpsertContacto(estadoHttp, cuerpo) {
  const error = clasificarError(estadoHttp, cuerpo);
  if (error) return { ok: false, ...error };
  const id = cuerpo && cuerpo.contact && cuerpo.contact.id;
  if (!id) return { ok: false, motivo: 'respuesta_invalida', reintentable: false, detalle: 'La respuesta no incluye contact.id' };
  return { ok: true, ghl_contact_id: id, nuevo: Boolean(cuerpo.new) };
}

// -----------------------------------------------------------------------------
// Disponibilidad
// -----------------------------------------------------------------------------

function solicitudDisponibilidad({ config, desde, dias, zonaHoraria }) {
  const inicio = aFecha(desde, 'desde');
  const rango = Math.min(Math.max(1, dias || config.dias_a_consultar || 7), MAX_DIAS_CONSULTA);
  return {
    metodo: 'GET',
    url: `${URL_BASE}/calendars/${encodeURIComponent(exigir(config.calendar_id, 'calendar_id de GoHighLevel'))}/free-slots`,
    cabeceras: cabeceras(VERSION.calendarios),
    consulta: {
      startDate: inicio.getTime(),
      endDate: inicio.getTime() + rango * MS_DIA,
      timezone: exigir(zonaHoraria, 'zona horaria'),
    },
  };
}

/**
 * Convierte la respuesta de /free-slots en la lista de horarios a ofrecer.
 * Respuesta: { "2026-10-08": { "slots": ["2026-10-08T09:00:00-05:00", ...] }, "traceId": "..." }
 *
 * Solo devuelve horarios presentes en la respuesta (AC 30); una lista vacía
 * significa sin_disponibilidad.
 */
function interpretarDisponibilidad(cuerpo, { ahora = new Date(), antelacionMinutos = 60, maximo = 4, maximoPorDia = 2 } = {}) {
  const limite = aFecha(ahora, 'ahora').getTime() + antelacionMinutos * 60 * 1000;
  const porDia = new Map();

  const fechas = Object.keys(cuerpo || {})
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();

  for (const fecha of fechas) {
    const slots = Array.isArray(cuerpo[fecha] && cuerpo[fecha].slots) ? cuerpo[fecha].slots : [];
    const validos = slots
      .filter((s) => !Number.isNaN(new Date(s).getTime()) && new Date(s).getTime() >= limite)
      .sort((a, b) => new Date(a) - new Date(b));
    if (validos.length) porDia.set(fecha, validos);
  }

  // Reparte la oferta entre días para dar opciones variadas.
  const elegidos = [];
  for (let ronda = 0; ronda < maximoPorDia && elegidos.length < maximo; ronda++) {
    for (const slots of porDia.values()) {
      if (elegidos.length >= maximo) break;
      if (slots[ronda]) elegidos.push(slots[ronda]);
    }
  }
  return elegidos.sort((a, b) => new Date(a) - new Date(b));
}

function formatearHorario(iso, zonaHoraria) {
  const texto = new Intl.DateTimeFormat('es-CO', {
    timeZone: zonaHoraria,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Texto para {{horarios_disponibles}}: opciones numeradas. */
function textoHorarios(slots, zonaHoraria) {
  return slots.map((s, i) => `${i + 1}. ${formatearHorario(s, zonaHoraria)}`).join('\n');
}

/**
 * AC 30: solo se reserva un horario que se ofreció. Devuelve el horario
 * ofrecido equivalente (misma hora absoluta) o null.
 */
function horarioOfrecido(inicio, ofrecidos) {
  const t = new Date(inicio).getTime();
  if (Number.isNaN(t)) return null;
  return (ofrecidos || []).find((s) => new Date(s).getTime() === t) || null;
}

// -----------------------------------------------------------------------------
// Reserva
// -----------------------------------------------------------------------------

/**
 * Crea la cita. ignoreFreeSlotValidation=false hace que GoHighLevel rechace
 * un horario que ya no está libre (AC 39) en lugar de crear una cita encima.
 */
function solicitudCrearCita({ config, ghlContactId, inicio, ofrecidos, titulo, modalidad, descripcion }) {
  const horario = horarioOfrecido(inicio, ofrecidos);
  if (!horario) throw new Error(`El horario ${inicio} no está entre los ofrecidos`);

  const cuerpo = {
    calendarId: exigir(config.calendar_id, 'calendar_id de GoHighLevel'),
    locationId: exigir(config.location_id, 'location_id de GoHighLevel'),
    contactId: exigir(ghlContactId, 'ghl_contact_id del contacto'),
    startTime: horario,
    title: titulo,
    appointmentStatus: 'confirmed',
    ignoreFreeSlotValidation: false,
    ignoreDateRange: false,
    toNotify: true,
  };
  if (config.duracion_minutos) {
    cuerpo.endTime = new Date(new Date(horario).getTime() + config.duracion_minutos * 60000).toISOString();
  }
  if (descripcion) cuerpo.description = descripcion;
  const tipo = modalidad && config.modalidades && config.modalidades[modalidad];
  if (tipo) cuerpo.meetingLocationType = tipo;

  return {
    metodo: 'POST',
    url: `${URL_BASE}/calendars/events/appointments`,
    cabeceras: cabeceras(VERSION.calendarios),
    cuerpo,
  };
}

/**
 * Resultado de la reserva. confirmada=true solo si GoHighLevel devolvió un id
 * y la cita quedó en un estado confirmado (AC 32). Una cita en estado "new"
 * existe pero el calendario exige confirmación manual: queda pendiente.
 */
function interpretarCrearCita(estadoHttp, cuerpo) {
  const error = clasificarError(estadoHttp, cuerpo);
  if (error) return { confirmada: false, ...error };

  const cita = cuerpo || {};
  if (!cita.id) {
    return { confirmada: false, motivo: 'respuesta_invalida', reintentable: false, detalle: 'La respuesta no incluye id' };
  }
  const estado = ESTADO_CITA[cita.appointmentStatus] || 'confirmada';
  return {
    confirmada: estado === 'confirmada',
    estado_cita: estado,
    id_externo: cita.id,
    inicio: cita.startTime,
    fin: cita.endTime || null,
    asesor_ghl_user_id: cita.assignedUserId || null,
  };
}

/**
 * AC 40: tras un timeout no se sabe si la cita se creó. Antes de reintentar
 * se consulta GET /contacts/{id}/appointments y se reutiliza la existente.
 */
function solicitudCitasDeContacto({ ghlContactId }) {
  return {
    metodo: 'GET',
    url: `${URL_BASE}/contacts/${encodeURIComponent(exigir(ghlContactId, 'ghl_contact_id del contacto'))}/appointments`,
    cabeceras: cabeceras(VERSION.contactos),
  };
}

function buscarCitaExistente(cuerpo, { calendarId, inicio }) {
  const t = new Date(inicio).getTime();
  const eventos = (cuerpo && Array.isArray(cuerpo.events)) ? cuerpo.events : [];
  const cita = eventos.find((e) =>
    e.calendarId === calendarId
    && new Date(e.startTime).getTime() === t
    && !['cancelled', 'invalid'].includes(e.appointmentStatus));
  return cita ? interpretarCrearCita(200, cita) : null;
}

// -----------------------------------------------------------------------------
// Errores
// -----------------------------------------------------------------------------

const PATRON_HORARIO_OCUPADO = /slot|no longer available|not available|disponib/i;

function mensajeError(cuerpo) {
  if (!cuerpo) return '';
  const m = cuerpo.message;
  return Array.isArray(m) ? m.join('; ') : String(m || cuerpo.error || '');
}

/** null si la respuesta es exitosa; si no, { motivo, reintentable, detalle }. */
function clasificarError(estadoHttp, cuerpo) {
  if (estadoHttp >= 200 && estadoHttp < 300) return null;
  const detalle = mensajeError(cuerpo);
  if (estadoHttp === 0 || estadoHttp === undefined || estadoHttp === null) {
    return { motivo: 'sin_respuesta', reintentable: true, detalle: detalle || 'Sin respuesta de GoHighLevel' };
  }
  if ((estadoHttp === 400 || estadoHttp === 409 || estadoHttp === 422) && PATRON_HORARIO_OCUPADO.test(detalle)) {
    return { motivo: 'horario_no_disponible', reintentable: false, detalle };
  }
  if (estadoHttp === 401 || estadoHttp === 403) {
    return { motivo: 'credencial_invalida', reintentable: false, detalle };
  }
  if (estadoHttp === 429 || estadoHttp >= 500) {
    return { motivo: 'proveedor_no_disponible', reintentable: true, detalle };
  }
  return { motivo: 'solicitud_rechazada', reintentable: false, detalle };
}

module.exports = {
  URL_BASE,
  VERSION,
  ESTADO_CITA,
  solicitudUpsertContacto,
  interpretarUpsertContacto,
  solicitudDisponibilidad,
  interpretarDisponibilidad,
  formatearHorario,
  textoHorarios,
  horarioOfrecido,
  solicitudCrearCita,
  interpretarCrearCita,
  solicitudCitasDeContacto,
  buscarCitaExistente,
  clasificarError,
};
