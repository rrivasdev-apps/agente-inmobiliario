'use strict';

/**
 * Agendamiento en el flujo de n8n: decide el paso del turno y arma o
 * interpreta las llamadas a GoHighLevel con src/integraciones/gohighlevel.js,
 * que se recibe como parámetro `ghl` (en n8n ambos módulos van en el mismo
 * nodo Code, sin require).
 *
 * Las respuestas HTTP llegan del nodo HTTP Request con "Full Response" y
 * "Never Error": { statusCode, body }. Una falla de red llega como { error }.
 */

const ESTADOS_CON_CITA = new Set([
  'seleccion_pendiente_confirmacion',
  'cita_confirmada',
  'entregado_asesor',
  'cita_reprogramada',
  'atencion_comercial_iniciada',
]);

/** Cita pendiente o confirmada que todavía no ocurre: no se ofrece otra. */
function citaVigente(ctx) {
  const c = ctx.cita;
  return Boolean(c && ['seleccion_pendiente', 'confirmada', 'reprogramada'].includes(c.estado) && new Date(c.inicio) > new Date());
}

function config(ctx, categoria) {
  return (ctx.integraciones && ctx.integraciones[categoria]) || {};
}

function modalidadValida(ctx, pedida) {
  const disponibles = Object.keys(config(ctx, 'calendario').modalidades || {});
  if (pedida && disponibles.includes(pedida)) return pedida;
  return disponibles[0] || 'llamada';
}

/**
 * Paso de agendamiento del turno:
 *   'ofrecer'  – calificó y no hay horarios pendientes: registrar en GHL y ofrecer
 *   'reservar' – eligió uno de los horarios ofrecidos (AC 30)
 *   null       – nada que hacer (no calificó, ya tiene cita o no eligió)
 * `seleccion` es la que extrajo el LLM en este turno.
 */
function planificarAgenda(ctx, seleccion, preferencia = null) {
  const ev = ctx.evaluacion || {};
  // Propiedad que se revisa en una reunión ya agendada: no se ofrecen horarios;
  // al calificar se deja una nota para el asesor, una sola vez.
  const op = ctx.oportunidad || {};
  if (op.cita_compartida) {
    return ev.resultado === 'calificado' && !op.nota_asesor_en ? { paso: 'nota' } : { paso: null };
  }
  // Prioridad alta se agenda; prioridad baja solo si el tenant la agenda a futuro
  // (el evaluador devuelve ofrecer_agenda con agendar_desde_dias); si la nutre, no.
  if (ev.accion !== 'ofrecer_agenda' || ESTADOS_CON_CITA.has(ctx.contacto.estado) || citaVigente(ctx)) return { paso: null };
  // Quien regresa tras días sin escribir primero recibe el saludo; los horarios, en el turno siguiente.
  if (ctx.retorno) return { paso: null };

  const ofrecidos = (ctx.conversacion.agenda && ctx.conversacion.agenda.ofrecidos) || [];
  const conPreferencia = (plan) => (preferencia ? { ...plan, preferencia } : plan);
  if (!ofrecidos.length) return conPreferencia({ paso: 'ofrecer' });

  const n = Number(seleccion && seleccion.horario);
  if (Number.isInteger(n) && n >= 1 && n <= ofrecidos.length) {
    // Se ocupó después de ofrecerlo: se buscan horarios nuevos en vez de reservar encima.
    if (ocupado(ctx)(ofrecidos[n - 1])) return { paso: 'ofrecer' };
    return { paso: 'reservar', inicio: ofrecidos[n - 1], modalidad: modalidadValida(ctx, seleccion.modalidad) };
  }
  // Pidió otro día u hora: se vuelve a consultar el calendario.
  if (preferencia) return { paso: 'ofrecer', preferencia };
  return { paso: null };
}

function intentar(fn) {
  try {
    return { solicitud: fn(), error: null };
  } catch (e) {
    return { solicitud: null, error: { motivo: 'configuracion', detalle: e.message } };
  }
}

/** Upsert del contacto calificado con la etiqueta del rol (AC 22-25). */
function solicitudContacto(ctx, ghl) {
  const datos = ctx.contacto.datos || {};
  return intentar(() => ghl.solicitudUpsertContacto({
    config: config(ctx, 'crm'),
    contacto: {
      nombre: datos.nombre || ctx.contacto.nombre,
      telefono: ctx.contacto.telefono || datos.telefono,
      email: ctx.contacto.email || datos.email,
      canal_origen: ctx.contacto.canal_origen,
      datos,
    },
    rol: { codigo: ctx.rol.codigo, etiqueta_crm: ctx.rol.etiqueta_crm },
  }));
}

function interpretarContacto(respuesta, ghl) {
  const r = respuesta || {};
  const resultado = ghl.interpretarUpsertContacto(r.statusCode, r.body);
  return resultado.ok
    ? { ghl_contact_id: resultado.ghl_contact_id, error: null }
    : { ghl_contact_id: null, error: resultado };
}

/** Instante en que empieza `fecha` (AAAA-MM-DD) en la zona dada. */
function inicioDelDia(fecha, zona) {
  const [y, m, d] = fecha.split('-').map(Number);
  const pared = Date.UTC(y, m - 1, d);
  const v = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(pared)).map((p) => [p.type, p.value]));
  const desfase = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - pared;
  return new Date(pared - desfase);
}

const fechaLocal = (iso, zona) => new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/**
 * Prioridad B (agendar a futuro, 26 oct 2026): el evaluador indica desde
 * cuántos días se ofrecen horarios (evaluacion.agendar_desde_dias). Devuelve
 * el inicio de ese día en la zona del tenant, o `ahora` para prioridad alta.
 */
function primerDiaAgendable(ctx, ahora) {
  const zona = ctx.tenant.zona_horaria;
  const dias = Number((ctx.evaluacion || {}).agendar_desde_dias);
  const desde = !Number.isFinite(dias) || dias <= 0 ? ahora : inicioDelDia(fechaLocal(new Date(ahora.getTime() + dias * 86400000), zona), zona);
  // Si ese día cae en vacaciones (parametros.agenda.vacaciones), se empieza al día siguiente de que terminan.
  const v = vacaciones(ctx);
  const f = fechaLocal(desde, zona);
  return v && f >= v.desde && f <= v.hasta ? inicioDelDia(diaSiguiente(v.hasta), zona) : desde;
}

/** parametros.agenda.vacaciones ({ desde, hasta: "AAAA-MM-DD", retorno_texto }) o null. */
function vacaciones(ctx) {
  const v = (((ctx.tenant.parametros || {}).agenda) || {}).vacaciones;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v.desde) && /^\d{4}-\d{2}-\d{2}$/.test(v.hasta) ? v : null;
}

function diaSiguiente(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Con preferencia de fecha se consulta desde ese día (o desde ahora si ya empezó). */
function solicitudHorarios(ctx, ghl, ahora = new Date(), preferencia = null) {
  const c = config(ctx, 'calendario');
  const desdeDia = preferencia && preferencia.fecha ? inicioDelDia(preferencia.fecha, ctx.tenant.zona_horaria) : null;
  const minimo = primerDiaAgendable(ctx, ahora);
  const desde = desdeDia && desdeDia > minimo ? desdeDia : minimo;
  return intentar(() => ghl.solicitudDisponibilidad({
    config: c, desde, dias: c.dias_a_consultar, zonaHoraria: ctx.tenant.zona_horaria,
  }));
}

const minutosDe = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Horario de atención (parametros.agenda.hora_minima / hora_maxima, "HH:MM" en
 * la zona del tenant, y dias_semana): no se ofrecen horarios fuera de él aunque
 * el calendario los tenga libres. hora_maxima es el cierre: el encuentro debe terminar a esa
 * hora (con la duración configurada; sin duración, debe empezar antes).
 */
// Días de atención (parametros.agenda.dias_semana), sin tildes: "lunes" … "domingo".
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const sinTildes = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/**
 * Ventanas de llamada de una fecha (cronograma de Javier, 22 oct 2026), como
 * [[desde, hasta], ...] en minutos, o null si no hay ventanas configuradas.
 * Orden: vacaciones -> excepción de la fecha -> viernes según su número en el
 * mes (viernes_rotacion) -> ventana semanal (ventanas_llamada). Un día sin
 * ventana en ventanas_llamada no tiene llamadas.
 */
function ventanasDelDia(a, fecha, dia, v) {
  const aMinutos = (lista) => (lista || []).map(([d, h]) => [minutosDe(d), minutosDe(h)]).filter(([d, h]) => d !== null && h !== null && d < h);
  if (v && fecha >= v.desde && fecha <= v.hasta) return [];
  const excepcion = (a.excepciones || []).find((e) => e && e.fecha === fecha);
  if (excepcion) return aMinutos(excepcion.ventanas);
  if (dia === 'viernes' && a.viernes_rotacion) {
    const n = String(Math.ceil(Number(fecha.slice(8, 10)) / 7));
    if (Array.isArray(a.viernes_rotacion[n])) return aMinutos(a.viernes_rotacion[n]);
  }
  if (a.ventanas_llamada) return aMinutos(a.ventanas_llamada[dia]);
  return null;
}

function dentroDelHorario(ctx) {
  const a = ((ctx.tenant.parametros || {}).agenda) || {};
  const min = minutosDe(a.hora_minima);
  const max = minutosDe(a.hora_maxima);
  const dias = Array.isArray(a.dias_semana) && a.dias_semana.length ? new Set(a.dias_semana.map(sinTildes)) : null;
  const v = vacaciones(ctx);
  const conCronograma = a.ventanas_llamada || a.viernes_rotacion || (a.excepciones || []).length || v;
  if (min === null && max === null && !dias && !conCronograma) return () => true;
  const duracion = Number(config(ctx, 'calendario').duracion_minutos) || 0;
  const zona = ctx.tenant.zona_horaria;
  const formato = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const diaSemana = new Intl.DateTimeFormat('en-US', { timeZone: zona, weekday: 'short' });
  const CORTOS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // El encuentro debe terminar dentro de la ventana (sin duración, debe empezar antes del cierre).
  const cabe = (t, desde, hasta) => t >= desde && (duracion ? t + duracion <= hasta : t < hasta);
  return (iso) => {
    const dia = DIAS[CORTOS.indexOf(diaSemana.format(new Date(iso)))];
    const [h, m] = formato.format(new Date(iso)).split(':').map(Number);
    const t = h * 60 + m;
    const ventanas = conCronograma ? ventanasDelDia(a, fechaLocal(iso, zona), dia, v) : null;
    if (ventanas) return ventanas.some(([desde, hasta]) => cabe(t, desde, hasta));
    if (dias && !dias.has(dia)) return false;
    return cabe(t, min === null ? 0 : min, max === null ? 24 * 60 : max);
  };
}

/**
 * Horario que ya tiene una cita activa registrada (ctx.horarios_ocupados). Con
 * duración configurada, también los que se cruzan con ella. Así no se ofrece
 * un horario ocupado aunque el calendario permita más de una cita por horario.
 */
function ocupado(ctx) {
  const inicios = (ctx.horarios_ocupados || []).map((i) => new Date(i).getTime()).filter((t) => !Number.isNaN(t));
  const dur = (Number(config(ctx, 'calendario').duracion_minutos) || 0) * 60000;
  return (iso) => {
    const t = new Date(iso).getTime();
    return inicios.some((o) => (dur ? t < o + dur && o < t + dur : t === o));
  };
}

/** Horarios a ofrecer (solo los que devolvió el calendario, AC 30). */
function interpretarHorarios(respuesta, ctx, ghl, ahora = new Date(), preferencia = null) {
  const r = respuesta || {};
  const error = ghl.clasificarError(r.statusCode, r.body);
  if (error) return { ofrecidos: [], texto: '', error };
  const c = config(ctx, 'calendario');
  const zona = ctx.tenant.zona_horaria;
  const maximo = c.horarios_a_ofrecer || 4;
  const base = (admitirExtra = () => true, porDia = c.horarios_por_dia || 2) => ghl.interpretarDisponibilidad(r.body, {
    ahora,
    antelacionMinutos: c.antelacion_minima_minutos ?? 60,
    maximo,
    maximoPorDia: porDia,
    admitir: (iso) => dentroDelHorario(ctx)(iso) && !ocupado(ctx)(iso) && new Date(iso) >= primerDiaAgendable(ctx, ahora) && admitirExtra(iso),
  });
  const salida = (ofrecidos, extra = {}) => ({ ofrecidos, texto: ghl.textoHorarios(ofrecidos, zona), error: null, ...extra });

  if (preferencia) {
    // Todas las opciones del día pedido (y de la franja, si la hay); si no hay, las más cercanas.
    const enDia = (iso) => !preferencia.fecha || fechaLocal(iso, zona) === preferencia.fecha;
    const desde = minutosDe(preferencia.desde);
    const hasta = minutosDe(preferencia.hasta);
    const minutos = (iso) => {
      const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: zona, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).split(':').map(Number);
      return h * 60 + m;
    };
    const enFranja = (iso) => (desde === null || minutos(iso) >= desde) && (hasta === null || minutos(iso) < hasta);
    const dia = preferencia.fecha ? diaTexto(preferencia.fecha, zona) : null;
    const conFranja = base((iso) => enDia(iso) && enFranja(iso), maximo);
    if (conFranja.length) return salida(conFranja, { motivo: 'preferencia', dia });
    const delDia = preferencia.fecha ? base(enDia, maximo) : [];
    if (delDia.length) return salida(delDia, { motivo: 'preferencia', dia });
    return salida(base(), { motivo: 'preferencia_sin_cupo', dia: dia || 'horario que pediste' });
  }
  return salida(base());
}

const CANAL = { whatsapp: 'WhatsApp', instagram_dm: 'Instagram', facebook_messenger: 'Messenger' };
// Datos de control de la conversación que no aportan al asesor.
const SIN_RESUMEN = new Set(['acepta_preguntas']);

/** Resumen para el asesor: origen, prioridad y los datos del caso, con sus etiquetas. */
function resumenDatos(ctx) {
  const etiquetas = new Map((ctx.rol.campos || []).map((c) => [c.clave, c.etiqueta]));
  const texto = (v) => (v === true ? 'sí' : v === false ? 'no' : v);
  const prioridad = ctx.evaluacion && ctx.evaluacion.prioridad;
  return [
    `Origen: ${CANAL[ctx.contacto.canal_origen || ctx.canal.tipo] || ctx.canal.tipo}`,
    prioridad ? `Prioridad: ${prioridad}` : null,
    ...Object.entries(ctx.contacto.datos || {})
      .filter(([k]) => !SIN_RESUMEN.has(k))
      .map(([k, v]) => `${etiquetas.get(k) || k}: ${texto(v)}`),
  ].filter(Boolean).join('\n');
}

function solicitudReserva(ctx, plan, ghl) {
  const nombre = (ctx.contacto.datos || {}).nombre || ctx.contacto.nombre || 'Contacto';
  return intentar(() => ghl.solicitudCrearCita({
    config: config(ctx, 'calendario'),
    ghlContactId: ctx.contacto.ghl_contact_id,
    inicio: plan.inicio,
    ofrecidos: ctx.conversacion.agenda.ofrecidos,
    titulo: `${ctx.rol.nombre_visible}: ${nombre}`,
    modalidad: plan.modalidad,
    descripcion: resumenDatos(ctx),
  }));
}

/** Nota en GoHighLevel con los datos de la propiedad que se suma a la reunión agendada. */
function solicitudNota(ctx, ghl) {
  const cita = ctx.oportunidad.cita_compartida;
  const { fecha_texto, hora_texto } = partesFecha(cita.inicio, ctx.tenant.zona_horaria);
  const texto = [
    `${ctx.rol.nombre_visible}: propiedad adicional para revisar en la reunión del ${fecha_texto}, ${hora_texto}.`,
    resumenDatos(ctx),
  ].join('\n');
  return intentar(() => ghl.solicitudNotaContacto({ ghlContactId: ctx.contacto.ghl_contact_id, texto }));
}

function interpretarNota(respuesta, previo, ghl) {
  if (previo && previo.error) return { ok: false, error: previo.error };
  const r = respuesta || {};
  const resultado = ghl.interpretarNotaContacto(r.statusCode, r.body);
  return resultado.ok ? { ok: true, error: null } : { ok: false, error: resultado };
}

/** "miércoles 21 de octubre" para una fecha AAAA-MM-DD. */
function diaTexto(fecha, zona) {
  const t = inicioDelDia(fecha, zona).getTime() + 12 * 3600000;
  return new Intl.DateTimeFormat('es-CO', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(t)).replace(',', '');
}

function partesFecha(iso, zona) {
  const d = new Date(iso);
  const fecha = new Intl.DateTimeFormat('es-CO', { timeZone: zona, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const hora = new Intl.DateTimeFormat('es-CO', { timeZone: zona, hour: 'numeric', minute: '2-digit' }).format(d);
  const nombreZona = new Intl.DateTimeFormat('es-CO', { timeZone: zona, timeZoneName: 'long' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName');
  // "hora estándar de Colombia" -> "Colombia", para la plantilla "zona horaria {{zona_horaria}}".
  const zonaTexto = nombreZona ? nombreZona.value.replace(/^hora (estándar )?(de )?/i, '') : zona;
  // Intl usa espacios estrechos sin quiebre ("9:00 a. m."); se normalizan.
  const limpiar = (t) => t.replace(/[\u00a0\u202f]/g, ' ');
  return { fecha_texto: limpiar(fecha.replace(',', '')), hora_texto: limpiar(hora), zona_texto: zonaTexto };
}

/** Citas del contacto en GoHighLevel, para no duplicar una que ya exista (AC 40). */
function solicitudCitasPrevias(ctx, ghl) {
  return intentar(() => ghl.solicitudCitasDeContacto({ ghlContactId: ctx.contacto.ghl_contact_id }));
}

/**
 * AC 40: si el contacto ya tiene en el calendario una cita en el horario
 * elegido que no está registrada (un intento anterior la creó y luego falló,
 * o la reserva no respondió a tiempo), se reutiliza en vez de crear otra.
 * Devuelve una respuesta con la forma de "crear cita", o null para crearla.
 * Si la consulta falló, también null: se intenta crear como siempre.
 */
function citaYaCreada(respuesta, ctx, plan, ghl) {
  const r = respuesta || {};
  if (!(r.statusCode >= 200 && r.statusCode < 300)) return null;
  const e = ghl.encontrarCitaExistente(r.body, {
    calendarId: config(ctx, 'calendario').calendar_id,
    inicio: plan.inicio,
    zonaHoraria: ctx.tenant.zona_horaria,
    excluir: ctx.citas_externas || [],
  });
  // La lista trae la hora sin zona: se usa la del horario elegido.
  return e ? { statusCode: 200, body: { ...e, startTime: plan.inicio } } : null;
}

/** Datos para app.registrar_cita. `previo` es la salida de solicitudReserva. */
function interpretarReserva(respuesta, ctx, plan, previo, ghl) {
  const r = respuesta || {};
  const resultado = previo && previo.error
    ? { confirmada: false, motivo: previo.error.motivo, reintentable: false, detalle: previo.error.detalle }
    : ghl.interpretarCrearCita(r.statusCode, r.body);
  const zona = ctx.tenant.zona_horaria;
  return {
    inicio: plan.inicio,
    modalidad: plan.modalidad,
    zona_horaria: zona,
    ...partesFecha(resultado.inicio || plan.inicio, zona),
    resultado,
  };
}

module.exports = {
  planificarAgenda,
  solicitudContacto,
  interpretarContacto,
  solicitudHorarios,
  interpretarHorarios,
  solicitudReserva,
  interpretarReserva,
  solicitudNota,
  solicitudCitasPrevias,
  citaYaCreada,
  interpretarNota,
};
