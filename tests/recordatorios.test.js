'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../src/n8n/meta');
const reporte = require('../src/n8n/reporte');
const { armarRecordatorio } = require('../src/n8n/recordatorios');
const { flujo, flujoRecordatorios } = require('../scripts/generar-n8n');
const { parametros } = require('../config/tenants/javier-nunez/tenant.json');

// --- Recordatorio de prioridad B (reunión del 27 oct 2026, decisión del 4 nov) ---------

const fila = {
  tenant: { id: 't1', nombre: 'JNdelT', zona_horaria: 'America/Bogota' },
  destinatarios: ['javier@x.co', 'sin-arroba'],
  contactos: [{
    contacto_id: 'c1', nombre: '<i>Ana</i>', telefono: '+573001', canal: 'whatsapp', barrio: 'Cedritos',
    tipo_inmueble: 'apartamento', valor_estimado_cop: '650000000', plazo_meses: 10,
    en_nutricion_desde: '2026-11-04T15:00:00Z', fecha_estimada: '2027-09-04T15:00:00Z',
  }],
};

test('recordatorio: correo a los destinatarios con los contactos, escapado y con sus ids', () => {
  const r = armarRecordatorio(fila);
  assert.equal(r.enviar, true);
  assert.equal(r.para, 'javier@x.co');
  assert.equal(r.tenant_id, 't1');
  assert.match(r.asunto, /1 propietario para contactar/);
  assert.match(r.html, /&lt;i&gt;Ana&lt;\/i&gt;/);
  assert.match(r.html, /650 M/);
  assert.match(r.html, /Cedritos/);
  assert.deepEqual(JSON.parse(Buffer.from(r.contactos_b64, 'base64').toString('utf8')), ['c1']);
});

test('recordatorio: sin contactos o sin destinatarios no se envía', () => {
  assert.equal(armarRecordatorio({ ...fila, contactos: [] }).enviar, false);
  assert.equal(armarRecordatorio({ ...fila, destinatarios: [] }).enviar, false);
  assert.match(armarRecordatorio({ ...fila, contactos: [{ ...fila.contactos[0], valor_estimado_cop: null }] }).html, /No lo dio/);
});

test('flujo de recordatorio: diario, en hora de Bogotá, y marca solo después de enviar', () => {
  const sig = (n) => flujoRecordatorios.connections[n].main[0].map((d) => d.node);
  assert.equal(flujoRecordatorios.settings.timezone, 'America/Bogota');
  const disparador = flujoRecordatorios.nodes.find((n) => n.name === 'Cada día 7:40');
  assert.equal(disparador.parameters.rule.interval[0].field, 'days');
  assert.deepEqual(sig('Recordatorios por tenant'), ['Armar correo']);
  assert.deepEqual(sig('¿Hay a quién avisar?'), ['Enviar recordatorio']);
  assert.deepEqual(sig('Enviar recordatorio'), ['Marcar enviados']);
  const marcar = flujoRecordatorios.nodes.find((n) => n.name === 'Marcar enviados');
  assert.match(marcar.parameters.query, /marcar_recordatorios_prioridad_b\('\{\{ \$\('Armar correo'\)\.item\.json\.tenant_id \}\}'::uuid/);
  for (const [desde, c] of Object.entries(flujoRecordatorios.connections)) {
    assert.ok(flujoRecordatorios.nodes.some((n) => n.name === desde), desde);
    for (const d of c.main.flat()) assert.ok(flujoRecordatorios.nodes.some((n) => n.name === d.node), d.node);
  }
});

test('parámetros: alta hasta 3 meses y recordatorio 2 meses antes, sin agenda a futuro', () => {
  assert.equal(parametros.prioridad.alta_hasta_meses, 3);
  assert.equal(parametros.prioridad.recordatorio_meses_antes, 2);
  assert.equal(parametros.prioridad.baja_agendar_desde_dias, undefined);
  assert.equal(parametros.propietarios.tolerancia_valor_pct, 10);
});

// --- Reporte semanal: barrios que no están en el listado ------------------------------

test('reporte: incluye los barrios que no están en el listado', () => {
  const r = reporte.armarReporte({
    tenant: { nombre: 'JNdelT', zona_horaria: 'America/Bogota' }, desde: '2026-10-28T12:00:00Z', hasta: '2026-11-04T12:00:00Z',
    destinatarios: ['javier@x.co'], no_calificados: [], prioridad_baja: [],
    barrios_no_listados: [{ fecha: '2026-11-02T15:00:00Z', nombre: 'Pablo', barrio: 'La Floresta', direccion: 'Cl 98 # 60-10', detalle: 'Barrio desconocido: "La Floresta"' }],
  });
  assert.match(r.html, /Barrios que no están en el listado \(1\)/);
  assert.match(r.html, /La Floresta/);
  assert.match(reporte.armarReporte({ tenant: {}, desde: '2026-10-28T12:00:00Z', hasta: '2026-11-04T12:00:00Z' }).html, /Barrios que no están en el listado \(0\)/);
});

// --- Retraso de escritura ---------------------------------------------------------------

test('retraso de escritura: proporcional al largo, entre el mínimo y el máximo', () => {
  const c = parametros.conversacion.retraso_escritura;
  assert.equal(meta.segundosEscritura('Hola', c), 2, 'un mensaje corto espera el mínimo');
  assert.equal(meta.segundosEscritura('x'.repeat(150), c), 5);
  assert.equal(meta.segundosEscritura('x'.repeat(1000), c), 8, 'nunca más que el máximo');
  assert.equal(meta.segundosEscritura('x'.repeat(1000), null), 0, 'sin configuración no se espera');
  assert.equal(meta.segundosEscritura('x', { minimo_s: 5, maximo_s: 2, caracteres_por_segundo: 30 }), 0, 'configuración inválida');
});

test('flujo: la espera va entre preparar el envío y enviar', () => {
  const sig = (n) => flujo.connections[n].main[0].map((d) => d.node);
  assert.deepEqual(sig('Preparar envío'), ['Simular escritura']);
  assert.deepEqual(sig('Simular escritura'), ['¿WhatsApp?']);
  const espera = flujo.nodes.find((n) => n.name === 'Simular escritura');
  assert.equal(espera.type, 'n8n-nodes-base.wait');
  assert.equal(espera.parameters.amount, '={{ $json.espera_s }}');
});
