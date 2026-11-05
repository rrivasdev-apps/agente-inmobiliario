'use strict';

/**
 * Recordatorio diario de prioridad B (reunión del 27 oct 2026): a partir de una
 * fila de app.recordatorios_prioridad_b(), arma el correo a Javier con los
 * propietarios cuya fecha estimada de venta se acerca, para que los contacte él.
 * Va por correo para no gastar mensajes de la API de WhatsApp.
 */

function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fecha(iso, zona) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: zona, day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(iso)).replace(/[  ]/g, ' ');
}

function millones(cop) {
  const n = Number(cop);
  return Number.isFinite(n) && n > 0 ? `${new Intl.NumberFormat('es-CO').format(Math.round(n / 1e6))} M` : 'No lo dio';
}

const COLUMNAS = [
  { titulo: 'Nombre', valor: (f) => f.nombre || '—' },
  { titulo: 'Teléfono', valor: (f) => f.telefono || '—' },
  { titulo: 'Canal', valor: (f) => f.canal || '—' },
  { titulo: 'Barrio', valor: (f) => f.barrio || '—' },
  { titulo: 'Inmueble', valor: (f) => f.tipo_inmueble || '—' },
  { titulo: 'Valor estimado', valor: (f) => millones(f.valor_estimado_cop) },
  { titulo: 'Plazo que dio (meses)', valor: (f) => f.plazo_meses ?? '—' },
  { titulo: 'Conversó el', valor: (f, z) => fecha(f.en_nutricion_desde, z) },
  { titulo: 'Fecha estimada de venta', valor: (f, z) => fecha(f.fecha_estimada, z) },
];

/**
 * @param {object} r  fila de app.recordatorios_prioridad_b()
 * @returns {{ enviar: boolean, tenant_id: string, para: string, asunto: string, html: string, contactos_b64: string }}
 */
function armarRecordatorio(r) {
  const zona = (r.tenant && r.tenant.zona_horaria) || 'America/Bogota';
  const destinatarios = (r.destinatarios || []).filter((d) => typeof d === 'string' && d.includes('@'));
  const contactos = r.contactos || [];
  const encabezado = COLUMNAS.map((c) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${escapar(c.titulo)}</th>`).join('');
  const filas = contactos.map((f) => `<tr>${COLUMNAS.map((c) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${escapar(c.valor(f, zona))}</td>`).join('')}</tr>`).join('');
  const html = [
    '<h2>Propietarios para llamar: se acerca su fecha de venta</h2>',
    `<p>${escapar(r.tenant && r.tenant.nombre)}. Estos propietarios conversaron con Lucía y dijeron que aún no tenían prisa (prioridad B). Se acerca la fecha en que pensaban vender: es buen momento para escribirles o llamarlos.</p>`,
    `<table style="border-collapse:collapse;font-size:14px"><thead><tr>${encabezado}</tr></thead><tbody>${filas}</tbody></table>`,
  ].join('\n');
  return {
    enviar: destinatarios.length > 0 && contactos.length > 0,
    tenant_id: r.tenant && r.tenant.id,
    para: destinatarios.join(','),
    asunto: `Prioridad B: ${contactos.length} ${contactos.length === 1 ? 'propietario para contactar' : 'propietarios para contactar'}`,
    html,
    contactos_b64: Buffer.from(JSON.stringify(contactos.map((c) => c.contacto_id)), 'utf8').toString('base64'),
  };
}

module.exports = { armarRecordatorio };
