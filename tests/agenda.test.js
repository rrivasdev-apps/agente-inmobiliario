'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agenda = require('../src/n8n/agenda');
const ghl = require('../src/integraciones/gohighlevel');
const sonia = require('../config/tenants/javier-nunez/roles/sonia.json');

const ZONA = 'America/Bogota';
const OFRECIDOS = ['2026-10-12T09:00:00-05:00', '2026-10-13T15:00:00-05:00'];

function ctx(extra = {}) {
  return {
    tenant: { id: 't1', nombre: 'Equipo', zona_horaria: ZONA },
    contacto: {
      id: 'c1', nombre: 'Lina WA', telefono: '+573005550001', email: null, canal_origen: 'whatsapp',
      estado: 'calificado_pendiente_agendamiento', ghl_contact_id: 'ghl_1',
      datos: { nombre: 'Lina', presupuesto_cop: 400000000 },
    },
    conversacion: { id: 'v1', agenda: {} },
    rol: { codigo: 'sonia', nombre_visible: 'Sonia', etiqueta_crm: 'agente-sonia', campos: sonia.campos },
    integraciones: {
      crm: { location_id: 'LOC1' },
      calendario: {
        location_id: 'LOC1', calendar_id: 'CAL1', dias_a_consultar: 7, antelacion_minima_minutos: 60,
        horarios_a_ofrecer: 4, horarios_por_dia: 2, modalidades: { llamada: 'phone', videollamada: 'gmeet' },
      },
    },
    evaluacion: { resultado: 'calificado', accion: 'ofrecer_agenda' },
    ...extra,
  };
}

test('plan: ofrece al calificar, reserva al elegir y no hace nada con cita o sin calificar', () => {
  assert.deepEqual(agenda.planificarAgenda(ctx(), null), { paso: 'ofrecer' });
  const conOferta = ctx({ conversacion: { id: 'v1', agenda: { ofrecidos: OFRECIDOS } } });
  assert.deepEqual(agenda.planificarAgenda(conOferta, { horario: 1, modalidad: 'videollamada' }),
    { paso: 'reservar', inicio: OFRECIDOS[0], modalidad: 'videollamada' });
  // Modalidad no configurada: se usa la primera del calendario.
  assert.equal(agenda.planificarAgenda(conOferta, { horario: 2, modalidad: 'presencial' }).modalidad, 'llamada');
  // AC 30: un número fuera de la lista no reserva.
  assert.deepEqual(agenda.planificarAgenda(conOferta, { horario: 3 }), { paso: null });
  assert.deepEqual(agenda.planificarAgenda(conOferta, null), { paso: null });
  assert.deepEqual(agenda.planificarAgenda(ctx({ evaluacion: { resultado: 'informacion_incompleta' } }), null), { paso: null });
  assert.deepEqual(agenda.planificarAgenda(ctx({ contacto: { ...ctx().contacto, estado: 'cita_confirmada' } }), null), { paso: null });
});

test('contacto: upsert con etiqueta del rol y canal; configuración pendiente no rompe el flujo', () => {
  const ok = agenda.solicitudContacto(ctx(), ghl);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.solicitud.cuerpo.tags, ['agente-sonia', 'canal-whatsapp']);
  assert.equal(ok.solicitud.cuerpo.name, 'Lina');

  const pendiente = agenda.solicitudContacto(ctx({ integraciones: { crm: { location_id: 'PENDIENTE' } } }), ghl);
  assert.equal(pendiente.solicitud, null);
  assert.equal(pendiente.error.motivo, 'configuracion');

  assert.deepEqual(agenda.interpretarContacto({ statusCode: 201, body: { contact: { id: 'g9' }, new: true } }, ghl), { ghl_contact_id: 'g9', error: null });
  assert.equal(agenda.interpretarContacto({ statusCode: 401, body: { message: 'Invalid JWT' } }, ghl).error.motivo, 'credencial_invalida');
  assert.equal(agenda.interpretarContacto({ error: { message: 'ETIMEDOUT' } }, ghl).error.motivo, 'sin_respuesta');
});

test('horarios: solo los que devuelve el calendario, con texto numerado', () => {
  const s = agenda.solicitudHorarios(ctx(), ghl, new Date('2026-10-11T12:00:00Z'));
  assert.match(s.solicitud.url, /\/calendars\/CAL1\/free-slots$/);
  assert.equal(s.solicitud.consulta.timezone, ZONA);

  const r = agenda.interpretarHorarios({
    statusCode: 200,
    body: { '2026-10-12': { slots: [OFRECIDOS[0]] }, '2026-10-13': { slots: [OFRECIDOS[1]] }, traceId: 'x' },
  }, ctx(), ghl, new Date('2026-10-11T12:00:00Z'));
  assert.deepEqual(r.ofrecidos, OFRECIDOS);
  assert.match(r.texto, /^1\. Lunes, 12 de octubre/);
  assert.equal(agenda.interpretarHorarios({ statusCode: 200, body: { traceId: 'x' } }, ctx(), ghl).ofrecidos.length, 0);
  assert.equal(agenda.interpretarHorarios({ statusCode: 503, body: {} }, ctx(), ghl).error.motivo, 'proveedor_no_disponible');
});

test('reserva: solo horarios ofrecidos y resultado listo para la plantilla de confirmación', () => {
  const c = ctx({ conversacion: { id: 'v1', agenda: { ofrecidos: OFRECIDOS } } });
  const plan = { paso: 'reservar', inicio: OFRECIDOS[0], modalidad: 'videollamada' };
  const s = agenda.solicitudReserva(c, plan, ghl);
  assert.equal(s.solicitud.cuerpo.contactId, 'ghl_1');
  assert.equal(s.solicitud.cuerpo.meetingLocationType, 'gmeet');
  assert.equal(s.solicitud.cuerpo.title, 'Sonia: Lina');
  assert.match(s.solicitud.cuerpo.description, /Presupuesto aproximado \(COP\): 400000000/);

  const ok = agenda.interpretarReserva(
    { statusCode: 201, body: { id: 'evt1', appointmentStatus: 'confirmed', startTime: OFRECIDOS[0], assignedUserId: 'u1' } },
    c, plan, s, ghl);
  assert.equal(ok.resultado.confirmada, true);
  assert.equal(ok.resultado.asesor_ghl_user_id, 'u1');
  assert.equal(ok.fecha_texto, 'lunes 12 de octubre');
  assert.equal(ok.hora_texto, '9:00 a. m.');
  assert.equal(ok.zona_texto, 'Colombia');

  const ocupado = agenda.interpretarReserva({ statusCode: 400, body: { message: 'The slot you have selected is no longer available' } }, c, plan, s, ghl);
  assert.equal(ocupado.resultado.motivo, 'horario_no_disponible');

  // Sin ghl_contact_id la solicitud no se arma y el resultado es un error, no una cita.
  const sinGhl = ctx({ contacto: { ...c.contacto, ghl_contact_id: null }, conversacion: c.conversacion });
  const previo = agenda.solicitudReserva(sinGhl, plan, ghl);
  assert.equal(previo.solicitud, null);
  const r = agenda.interpretarReserva({ error: { message: 'Invalid URL' } }, sinGhl, plan, previo, ghl);
  assert.equal(r.resultado.confirmada, false);
  assert.equal(r.resultado.motivo, 'configuracion');
});
