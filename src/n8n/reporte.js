'use strict';

/**
 * Reporte semanal de leads no calificados y de prioridad baja (nutrición),
 * a partir de app.reportes_no_calificados(). Arma el correo para el
 * administrador del tenant (parametros.reporte_no_calificados.destinatarios).
 */

const ROL = { lucia: 'Lucía (vende / ofrece en arriendo)', sonia: 'Sonia (compra / busca arriendo)' };

function escapar(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fecha(iso, zona) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: zona, day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(iso)).replace(/[  ]/g, ' ');
}

function tabla(titulo, filas, columnas, zona) {
  if (!filas.length) return `<h3>${escapar(titulo)} (0)</h3><p>Sin registros en el periodo.</p>`;
  const encabezado = columnas.map((c) => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">${escapar(c.titulo)}</th>`).join('');
  const cuerpo = filas.map((f) => `<tr>${columnas.map((c) => `<td style="padding:4px 8px;border-bottom:1px solid #eee">${escapar(c.valor(f, zona))}</td>`).join('')}</tr>`).join('');
  return `<h3>${escapar(titulo)} (${filas.length})</h3><table style="border-collapse:collapse;font-size:14px"><thead><tr>${encabezado}</tr></thead><tbody>${cuerpo}</tbody></table>`;
}

const COMUNES = [
  { titulo: 'Fecha', valor: (f, z) => fecha(f.fecha, z) },
  { titulo: 'Nombre', valor: (f) => f.nombre || '—' },
  { titulo: 'Teléfono', valor: (f) => f.telefono || '—' },
  { titulo: 'Canal', valor: (f) => f.canal || '—' },
  { titulo: 'Agente', valor: (f) => ROL[f.rol] || f.rol || '—' },
  { titulo: 'Operación', valor: (f) => f.operacion || '—' },
];

/**
 * @param {object} r  fila de app.reportes_no_calificados()
 * @returns {{ enviar: boolean, para: string, asunto: string, html: string }}
 */
function armarReporte(r) {
  const zona = (r.tenant && r.tenant.zona_horaria) || 'America/Bogota';
  const destinatarios = (r.destinatarios || []).filter((d) => typeof d === 'string' && d.includes('@'));
  const noCalificados = r.no_calificados || [];
  const baja = r.prioridad_baja || [];
  const periodo = `${fecha(r.desde, zona)} al ${fecha(r.hasta, zona)}`;
  const html = [
    `<h2>Leads no calificados y de prioridad baja</h2>`,
    `<p>${escapar(r.tenant && r.tenant.nombre)} · ${escapar(periodo)}</p>`,
    tabla('No calificados', noCalificados, [...COMUNES, { titulo: 'Motivo', valor: (f) => f.motivo || '—' }], zona),
    tabla('Prioridad baja (en nutrición, no se agendaron)', baja, [
      ...COMUNES,
      { titulo: 'Plazo (meses)', valor: (f) => f.plazo_meses || '—' },
      { titulo: 'Estado actual', valor: (f) => f.estado_actual || '—' },
    ], zona),
  ].join('\n');
  return {
    enviar: destinatarios.length > 0,
    para: destinatarios.join(','),
    asunto: `Reporte semanal de leads: ${noCalificados.length} no calificados, ${baja.length} de prioridad baja (${periodo})`,
    html,
  };
}

module.exports = { armarReporte };
