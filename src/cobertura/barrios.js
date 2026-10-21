'use strict';

/**
 * Cobertura por barrio (reunión del 19 oct 2026).
 *
 * La fuente viva es la hoja "Barrios" de Google Sheets que edita el equipo:
 * n8n la lee, pasa las filas por prepararSincronizacion() y llama a
 * app.sincronizar_barrios(). Durante la conversación, la herramienta
 * resolver_zona lee las filas activas de app.barrios_cobertura y llama a
 * resolverBarrio().
 *
 * Sin dependencias para poder pegarse en un nodo Code de n8n
 * (scripts/generar-n8n.js lo incrusta en n8n/sincronizar-barrios.json).
 */

const ESTADO_ZONA = Object.freeze({
  ATENDIDO: 'atendido',
  NO_ATENDIDO: 'no_atendido',
  AMBIGUO: 'ambiguo',
  SIN_DEFINIR: 'sin_definir',
  DESCONOCIDO: 'desconocido',
});

// Igual a normalizarTexto de src/calificacion/evaluar.js, más espacios
// repetidos; se repite aquí para que el módulo siga sin dependencias.
function normalizar(valor) {
  return String(valor == null ? '' : valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Encabezados de la hoja, en el orden en que se prueban (Cód. UPZ antes que UPZ).
const COLUMNAS = [
  ['codigo_upz', (h) => h.startsWith('cod')],
  ['localidad', (h) => h.startsWith('localidad')],
  ['upz', (h) => h === 'upz'],
  ['barrio', (h) => h === 'barrio'],
  ['atiende', (h) => h.includes('atiendo')],
  ['notas', (h) => h.includes('notas')],
  ['observacion_dato', (h) => h.startsWith('observacion')],
  ['alias', (h) => h.startsWith('alias')],
];

function columna(encabezado) {
  const h = normalizar(encabezado);
  const encontrada = COLUMNAS.find(([, coincide]) => coincide(h));
  return encontrada ? encontrada[0] : null;
}

const SI = new Set(['si', 's', 'x', 'true']);
const NO = new Set(['no', 'n', 'false']);

function textoOpcional(valor) {
  const t = String(valor == null ? '' : valor).trim();
  return t === '' ? null : t;
}

/**
 * Convierte las filas de la hoja (objetos con los encabezados como claves,
 * tal como las entrega el nodo Google Sheets de n8n) en filas para
 * app.sincronizar_barrios.
 *
 * "Sí" → atiende true, "No" → false, vacío → null (sin definir).
 *
 * @param {object[]} filasHoja
 * @param {object} [opciones]
 * @param {number} [opciones.primeraFila=2]  número de fila de la hoja del primer elemento
 * @returns {{ filas: object[], advertencias: {fila, barrio, mensaje}[] }}
 */
function prepararSincronizacion(filasHoja, { primeraFila = 2 } = {}) {
  const filas = [];
  const advertencias = [];
  const vistas = new Map();

  (filasHoja || []).forEach((original, i) => {
    const fila = original.row_number || primeraFila + i;
    const r = {};
    for (const [encabezado, valor] of Object.entries(original)) {
      const clave = columna(encabezado);
      if (clave) r[clave] = valor;
    }
    const barrio = textoOpcional(r.barrio);
    const localidad = textoOpcional(r.localidad);
    const codigo = Number(String(r.codigo_upz == null ? '' : r.codigo_upz).trim());
    const avisar = (mensaje) => advertencias.push({ fila, barrio, mensaje });

    if (!barrio && !localidad && !textoOpcional(r.upz)) return; // fila vacía
    if (!barrio) return avisar('Fila sin barrio; se omite');
    if (!localidad) return avisar('Fila sin localidad; se omite');
    if (!Number.isInteger(codigo) || codigo <= 0) return avisar('Código de UPZ inválido; se omite');

    let atiende = null;
    const marca = normalizar(r.atiende);
    if (SI.has(marca)) atiende = true;
    else if (NO.has(marca)) atiende = false;
    else if (marca !== '') avisar(`Valor "${r.atiende}" no es Sí ni No; queda sin definir`);

    if (/\[truncado\]/i.test(barrio)) avisar('Nombre truncado en la fuente; corregir para que el agente lo reconozca');

    const clave = `${codigo}|${normalizar(barrio)}`;
    if (vistas.has(clave)) {
      avisar(`Barrio repetido en la misma UPZ (fila ${vistas.get(clave)}); se usa la última`);
      const previa = filas.findIndex((f) => `${f.codigo_upz}|${normalizar(f.barrio)}` === clave);
      filas.splice(previa, 1);
    }
    vistas.set(clave, fila);

    filas.push({
      localidad,
      codigo_upz: codigo,
      upz: textoOpcional(r.upz),
      barrio,
      alias: String(r.alias == null ? '' : r.alias).split(/[,;]/).map((a) => a.trim()).filter(Boolean),
      atiende,
      notas: textoOpcional(r.notas),
      observacion_dato: textoOpcional(r.observacion_dato),
    });
  });

  return { filas, advertencias };
}

// CSV con comillas al estilo RFC 4180, como lo exporta Google Sheets. Devuelve
// objetos con los encabezados como claves, igual que el nodo de n8n.
/**
 * Convierte la respuesta de la API de Google Sheets (values.get: arreglo de
 * filas, la primera con los encabezados) en objetos con número de fila.
 */
function filasDesdeValores(valores) {
  const [encabezados = [], ...resto] = valores || [];
  return resto.map((f, i) => ({
    row_number: i + 2,
    ...Object.fromEntries(encabezados.map((h, j) => [h, f[j] == null ? '' : f[j]])),
  }));
}

function parsearCsv(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i += 1; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i += 1;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  const [encabezados, ...resto] = filas.filter((f) => f.some((v) => v.trim() !== ''));
  return resto.map((f) => Object.fromEntries(encabezados.map((h, i) => [h, f[i] ?? ''])));
}

const PREFIJOS = /^(el |la )?(barrio|sector|urbanizacion|urb\.?|conjunto( residencial)?( en)?|edificio( en)?)\s+/;

function limpiarConsulta(texto) {
  return normalizar(texto).replace(/[.,;:]+$/, '').replace(PREFIJOS, '').trim();
}

function nombres(b) {
  return [b.barrio, ...(b.alias || [])].map(normalizar).filter(Boolean);
}

function buscar(consulta, barrios) {
  const q = limpiarConsulta(consulta);
  if (!q) return [];
  const exactos = barrios.filter((b) => nombres(b).includes(q));
  if (exactos.length) return exactos;
  // "Cedritos, Usaquén" o "en Pasadena cerca al parque": el nombre completo
  // del barrio aparece como palabras dentro del texto.
  const palabras = (t) => ` ${t.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const frase = palabras(q);
  return barrios.filter((b) => nombres(b).some((n) => n.length >= 4 && frase.includes(palabras(n))));
}

function resumen(b) {
  return { localidad: b.localidad, codigo_upz: b.codigo_upz, upz: b.upz, barrio: b.barrio, atiende: b.atiende };
}

/**
 * Decide si un barrio está dentro de la zona atendida.
 *
 * @param {string} texto  barrio tal como lo escribió la persona
 * @param {object[]} barrios  filas activas de app.barrios_cobertura del tenant
 * @param {object} [pistas]
 * @param {string} [pistas.localidad]  localidad declarada o geocodificada
 * @param {number|string} [pistas.upz]  código o nombre de UPZ, si la persona lo dio
 * @param {string} [pistas.barrioGeocodificado]  componente "neighborhood" de Google Maps
 * @returns {{ estado, candidatos }}
 */
function resolverBarrio(texto, barrios, { localidad, upz, barrioGeocodificado } = {}) {
  let candidatos = buscar(texto, barrios || []);
  if (!candidatos.length && barrioGeocodificado) candidatos = buscar(barrioGeocodificado, barrios || []);

  const filtrar = (lista, pista, campos) => {
    if (pista == null || String(pista).trim() === '') return lista;
    const p = normalizar(pista);
    const filtrada = lista.filter((b) => campos.some((c) => normalizar(b[c]) === p));
    return filtrada.length ? filtrada : lista; // una pista que no cuadra no descarta todo
  };
  candidatos = filtrar(candidatos, localidad, ['localidad']);
  candidatos = filtrar(candidatos, upz, ['codigo_upz', 'upz']);

  const lista = candidatos.map(resumen);
  if (!candidatos.length) return { estado: ESTADO_ZONA.DESCONOCIDO, candidatos: lista };

  const marcas = new Set(candidatos.map((b) => (b.atiende == null ? null : Boolean(b.atiende))));
  if (marcas.size > 1) {
    // Si al menos uno está sin definir y el resto coincide, sigue siendo una decisión de Javier.
    if (marcas.size === 2 && marcas.has(null)) return { estado: ESTADO_ZONA.SIN_DEFINIR, candidatos: lista };
    return { estado: ESTADO_ZONA.AMBIGUO, candidatos: lista };
  }
  const [marca] = marcas;
  if (marca === null) return { estado: ESTADO_ZONA.SIN_DEFINIR, candidatos: lista };
  return { estado: marca ? ESTADO_ZONA.ATENDIDO : ESTADO_ZONA.NO_ATENDIDO, candidatos: lista };
}

module.exports = { prepararSincronizacion, resolverBarrio, parsearCsv, filasDesdeValores, ESTADO_ZONA };
