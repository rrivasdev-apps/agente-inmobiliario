'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ghl = require('../src/integraciones/gohighlevel');

const config = {
  location_id: 'LOC123',
  calendar_id: 'CAL456',
  duracion_minutos: 30,
  modalidades: { llamada: 'phone', videollamada: 'gmeet' },
};
const lucia = { codigo: 'lucia', etiqueta_crm: 'agente-lucia' };
const sonia = { codigo: 'sonia', etiqueta_crm: 'agente-sonia' };
const ZONA = 'America/Bogota';

// Forma de respuesta de GET /calendars/{id}/free-slots según la especificación oficial.
const disponibilidad = {
  '2026-10-08': { slots: ['2026-10-08T09:00:00-05:00', '2026-10-08T10:00:00-05:00', '2026-10-08T11:00:00-05:00'] },
  '2026-10-09': { slots: ['2026-10-09T14:30:00-05:00', '2026-10-09T15:00:00-05:00'] },
  '2026-10-10': { slots: [] },
  traceId: 'abc-123',
};

// --- Contactos ---------------------------------------------------------------

test('upsert: etiqueta del rol y canal, sin asignar asesor (AC 24, AC 26)', () => {
  const s = ghl.solicitudUpsertContacto({
    config,
    rol: lucia,
    contacto: {
      nombre: 'Ana Pérez', telefono: '+573001112233', canal_origen: 'whatsapp',
      datos: { ciudad: 'Bogotá', direccion: 'Calle 63 # 9-15', direccion_normalizada: 'Cl. 63 #9-15, Bogotá' },
    },
  });
  assert.equal(s.metodo, 'POST');
  assert.equal(s.url, 'https://services.leadconnectorhq.com/contacts/upsert');
  assert.equal(s.cabeceras.Version, '2021-07-28');
  assert.deepEqual(s.cuerpo.tags, ['agente-lucia', 'canal-whatsapp']);
  assert.equal(s.cuerpo.locationId, 'LOC123');
  assert.equal(s.cuerpo.address1, 'Cl. 63 #9-15, Bogotá');
  assert.equal('assignedTo' in s.cuerpo, false);
  assert.equal('email' in s.cuerpo, false, 'no envía campos vacíos');
});

test('upsert: Sonia no envía dirección', () => {
  const s = ghl.solicitudUpsertContacto({
    config, rol: sonia,
    contacto: { nombre: 'Luis', email: 'luis@example.com', canal_origen: 'instagram_dm', datos: { direccion: 'x' } },
  });
  assert.equal('address1' in s.cuerpo, false);
  assert.deepEqual(s.cuerpo.tags, ['agente-sonia', 'canal-instagram_dm']);
});

test('upsert: exige teléfono o correo y configuración real', () => {
  assert.throws(() => ghl.solicitudUpsertContacto({ config, rol: lucia, contacto: { canal_origen: 'whatsapp' } }), /teléfono o correo/);
  assert.throws(() => ghl.solicitudUpsertContacto({
    config: { location_id: 'PENDIENTE' }, rol: lucia, contacto: { telefono: '+573001112233', canal_origen: 'whatsapp' },
  }), /location_id/);
});

test('upsert: interpreta la respuesta (AC 25)', () => {
  assert.deepEqual(ghl.interpretarUpsertContacto(200, { new: false, contact: { id: 'C1' }, traceId: 't' }),
    { ok: true, ghl_contact_id: 'C1', nuevo: false });
  assert.equal(ghl.interpretarUpsertContacto(201, {}).motivo, 'respuesta_invalida');
  assert.equal(ghl.interpretarUpsertContacto(503, {}).reintentable, true);
});

// --- Disponibilidad ----------------------------------------------------------

test('disponibilidad: arma la consulta con la versión de calendarios y tope de 31 días', () => {
  const s = ghl.solicitudDisponibilidad({ config, desde: '2026-10-07T12:00:00Z', dias: 90, zonaHoraria: ZONA });
  assert.equal(s.url, 'https://services.leadconnectorhq.com/calendars/CAL456/free-slots');
  assert.equal(s.cabeceras.Version, '2021-04-15');
  assert.equal(s.consulta.endDate - s.consulta.startDate, 31 * 24 * 3600 * 1000);
  assert.equal(s.consulta.timezone, ZONA);
});

test('disponibilidad: reparte entre días, ignora traceId y respeta el máximo', () => {
  const r = ghl.interpretarDisponibilidad(disponibilidad, { ahora: '2026-10-07T12:00:00Z', maximo: 3, maximoPorDia: 2 });
  assert.deepEqual(r, ['2026-10-08T09:00:00-05:00', '2026-10-08T10:00:00-05:00', '2026-10-09T14:30:00-05:00']);
});

test('disponibilidad: descarta horarios dentro de la antelación mínima', () => {
  const r = ghl.interpretarDisponibilidad(disponibilidad, { ahora: '2026-10-08T14:30:00Z', antelacionMinutos: 60 });
  // 14:30Z = 09:30 Bogotá; el primer horario válido es 11:00 (>= 10:30)
  assert.equal(r[0], '2026-10-08T11:00:00-05:00');
});

test('disponibilidad: sin horarios devuelve lista vacía (sin_disponibilidad)', () => {
  assert.deepEqual(ghl.interpretarDisponibilidad({ traceId: 'x' }), []);
  assert.deepEqual(ghl.interpretarDisponibilidad(null), []);
});

test('formato de horarios en español y zona horaria del tenant', () => {
  const texto = ghl.textoHorarios(['2026-10-08T09:00:00-05:00', '2026-10-09T14:30:00-05:00'], ZONA);
  const [l1, l2] = texto.split('\n');
  assert.match(l1, /^1\. Jueves.*8 de octubre.*9:00/);
  assert.match(l2, /^2\. Viernes.*9 de octubre.*2:30/);
});

// --- Reserva -----------------------------------------------------------------

const ofrecidos = ['2026-10-08T09:00:00-05:00', '2026-10-09T14:30:00-05:00'];

test('reserva: valida contra disponibilidad y no ignora la validación de horario (AC 39)', () => {
  const s = ghl.solicitudCrearCita({
    config, ghlContactId: 'C1', inicio: '2026-10-08T14:00:00Z', ofrecidos,
    titulo: 'Lucía · Ana Pérez', modalidad: 'llamada',
  });
  assert.equal(s.url, 'https://services.leadconnectorhq.com/calendars/events/appointments');
  assert.equal(s.cabeceras.Version, '2021-04-15');
  assert.equal(s.cuerpo.startTime, '2026-10-08T09:00:00-05:00', 'usa el horario ofrecido aunque llegue en otra zona');
  assert.equal(s.cuerpo.endTime, '2026-10-08T14:30:00.000Z');
  assert.equal(s.cuerpo.ignoreFreeSlotValidation, false);
  assert.equal(s.cuerpo.appointmentStatus, 'confirmed');
  assert.equal(s.cuerpo.meetingLocationType, 'phone');
  assert.equal('assignedUserId' in s.cuerpo, false, 'el calendario asigna al asesor');
});

test('reserva: rechaza un horario que no se ofreció (AC 30)', () => {
  assert.throws(() => ghl.solicitudCrearCita({ config, ghlContactId: 'C1', inicio: '2026-10-08T10:00:00-05:00', ofrecidos, titulo: 't' }),
    /no está entre los ofrecidos/);
});

test('reserva: confirmada solo con id y estado confirmado (AC 32)', () => {
  const ok = ghl.interpretarCrearCita(200, {
    id: 'EVT1', calendarId: 'CAL456', locationId: 'LOC123', contactId: 'C1',
    startTime: '2026-10-08T09:00:00-05:00', endTime: '2026-10-08T09:30:00-05:00',
    appointmentStatus: 'confirmed', assignedUserId: 'USR9',
  });
  assert.equal(ok.confirmada, true);
  assert.equal(ok.id_externo, 'EVT1');
  assert.equal(ok.asesor_ghl_user_id, 'USR9');

  const pendiente = ghl.interpretarCrearCita(200, { id: 'EVT2', appointmentStatus: 'new' });
  assert.equal(pendiente.confirmada, false);
  assert.equal(pendiente.estado_cita, 'seleccion_pendiente');

  assert.equal(ghl.interpretarCrearCita(200, {}).confirmada, false);
});

test('reserva: clasifica errores sin confirmar falsamente (AC 41)', () => {
  const ocupado = ghl.interpretarCrearCita(400, { statusCode: 400, message: 'The slot you have selected is no longer available' });
  assert.deepEqual([ocupado.confirmada, ocupado.motivo], [false, 'horario_no_disponible']);

  assert.equal(ghl.interpretarCrearCita(400, { message: ['contactId must be a string'] }).motivo, 'solicitud_rechazada');
  assert.equal(ghl.interpretarCrearCita(401, { message: 'Invalid JWT' }).motivo, 'credencial_invalida');
  const caido = ghl.interpretarCrearCita(502, null);
  assert.deepEqual([caido.confirmada, caido.reintentable], [false, true]);
  assert.equal(ghl.interpretarCrearCita(0, null).motivo, 'sin_respuesta');
});

test('reintento: reutiliza la cita existente en lugar de duplicarla (AC 40)', () => {
  const s = ghl.solicitudCitasDeContacto({ ghlContactId: 'C1' });
  assert.equal(s.url, 'https://services.leadconnectorhq.com/contacts/C1/appointments');

  const respuesta = {
    events: [
      { id: 'OLD', calendarId: 'CAL456', startTime: '2026-10-08T09:00:00-05:00', appointmentStatus: 'cancelled' },
      { id: 'EVT1', calendarId: 'CAL456', startTime: '2026-10-08T14:00:00.000Z', appointmentStatus: 'confirmed', assignedUserId: 'USR9' },
    ],
  };
  const existente = ghl.buscarCitaExistente(respuesta, { calendarId: 'CAL456', inicio: '2026-10-08T09:00:00-05:00' });
  assert.equal(existente.id_externo, 'EVT1');
  assert.equal(existente.confirmada, true);
  assert.equal(ghl.buscarCitaExistente(respuesta, { calendarId: 'OTRO', inicio: '2026-10-08T09:00:00-05:00' }), null);
});
