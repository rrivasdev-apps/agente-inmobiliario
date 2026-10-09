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
function planificarAgenda(ctx, seleccion) {
  const ev = ctx.evaluacion || {};
  // Solo prioridad alta se agenda; prioridad baja (accion nutrir) no.
  if (ev.accion !== 'ofrecer_agenda' || ESTADOS_CON_CITA.has(ctx.contacto.estado)) return { paso: null };

  const ofrecidos = (ctx.conversacion.agenda && ctx.conversacion.agenda.ofrecidos) || [];
  if (!ofrecidos.length) return { paso: 'ofrecer' };

  const n = Number(seleccion && seleccion.horario);
  if (Number.isInteger(n) && n >= 1 && n <= ofrecidos.length) {
    return { paso: 'reservar', inicio: ofrecidos[n - 1], modalidad: modalidadValida(ctx, seleccion.modalidad) };
  }
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

function solicitudHorarios(ctx, ghl, ahora = new Date()) {
  const c = config(ctx, 'calendario');
  return intentar(() => ghl.solicitudDisponibilidad({
    config: c, desde: ahora, dias: c.dias_a_consultar, zonaHoraria: ctx.tenant.zona_horaria,
  }));
}

/** Horarios a ofrecer (solo los que devolvió el calendario, AC 30). */
function interpretarHorarios(respuesta, ctx, ghl, ahora = new Date()) {
  const r = respuesta || {};
  const error = ghl.clasificarError(r.statusCode, r.body);
  if (error) return { ofrecidos: [], texto: '', error };
  const c = config(ctx, 'calendario');
  const ofrecidos = ghl.interpretarDisponibilidad(r.body, {
    ahora,
    antelacionMinutos: c.antelacion_minima_minutos ?? 60,
    maximo: c.horarios_a_ofrecer || 4,
    maximoPorDia: c.horarios_por_dia || 2,
  });
  return { ofrecidos, texto: ghl.textoHorarios(ofrecidos, ctx.tenant.zona_horaria), error: null };
}

function resumenDatos(ctx) {
  const etiquetas = new Map((ctx.rol.campos || []).map((c) => [c.clave, c.etiqueta]));
  return Object.entries(ctx.contacto.datos || {})
    .map(([k, v]) => `${etiquetas.get(k) || k}: ${v}`)
    .join('\n');
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
};
