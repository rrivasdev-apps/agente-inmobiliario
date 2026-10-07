'use strict';

/**
 * Evaluador determinista de calificación (PRD §5.4, §6.3, AC 19, AC 21).
 *
 * El LLM solo extrae datos de la conversación; la decisión de calificar se
 * toma aquí, con los criterios configurados en app.roles_agente.criterios.
 * El módulo no tiene dependencias para poder pegarse en un nodo Code de n8n.
 *
 * Formato de criterios:
 * {
 *   "campos_obligatorios": ["nombre", "direccion", ...],
 *   "reglas": [
 *     { "id": "intencion", "campo": "intencion_venta", "operador": "igual",
 *       "valor": true, "motivo": "No manifestó intención de vender" }
 *   ]
 * }
 *
 * Operadores: igual, distinto, en, no_en, mayor_o_igual, menor_o_igual,
 * entre ([min, max]), presente.
 */

const RESULTADO = Object.freeze({
  CALIFICADO: 'calificado',
  NO_CALIFICADO: 'no_calificado',
  INFORMACION_INCOMPLETA: 'informacion_incompleta',
});

const ACCION = Object.freeze({
  SOLICITAR_DATOS: 'solicitar_datos',
  VERIFICAR_DIRECCION: 'verificar_direccion',
  ACLARAR_DIRECCION: 'aclarar_direccion',
  REINTENTAR_VERIFICACION: 'reintentar_verificacion',
  OFRECER_AGENDA: 'ofrecer_agenda',
  ARCHIVAR: 'archivar',
});

const OPERADORES = new Set([
  'igual', 'distinto', 'en', 'no_en', 'mayor_o_igual', 'menor_o_igual', 'entre', 'presente',
]);

function normalizarTexto(valor) {
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function normalizar(valor) {
  return typeof valor === 'string' ? normalizarTexto(valor) : valor;
}

function estaPresente(valor) {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string') return valor.trim() !== '';
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}

function obtener(datos, ruta) {
  return ruta.split('.').reduce((acc, parte) => (acc == null ? undefined : acc[parte]), datos);
}

function aNumero(valor) {
  if (typeof valor === 'number') return valor;
  if (typeof valor !== 'string') return NaN;
  let limpio = valor.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(limpio)) return NaN;
  // "450.000.000" o "450,000,000": separadores de miles.
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(limpio)) limpio = limpio.replace(/[.,]/g, '');
  else limpio = limpio.replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : NaN;
}

function cumpleRegla(regla, valor) {
  switch (regla.operador) {
    case 'presente':
      return estaPresente(valor);
    case 'igual':
      return normalizar(valor) === normalizar(regla.valor);
    case 'distinto':
      return estaPresente(valor) && normalizar(valor) !== normalizar(regla.valor);
    case 'en':
      return regla.valor.map(normalizar).includes(normalizar(valor));
    case 'no_en':
      return estaPresente(valor) && !regla.valor.map(normalizar).includes(normalizar(valor));
    case 'mayor_o_igual':
      return aNumero(valor) >= regla.valor;
    case 'menor_o_igual':
      return aNumero(valor) <= regla.valor;
    case 'entre': {
      const n = aNumero(valor);
      return n >= regla.valor[0] && n <= regla.valor[1];
    }
    default:
      throw new Error(`Operador desconocido: ${regla.operador}`);
  }
}

/**
 * Valida la forma de los criterios. Se usa al guardar configuración y en
 * pruebas, para que un error de configuración no llegue a producción.
 */
function validarCriterios(criterios) {
  const errores = [];
  if (!criterios || typeof criterios !== 'object') {
    return ['criterios debe ser un objeto'];
  }
  if (!Array.isArray(criterios.campos_obligatorios)) {
    errores.push('campos_obligatorios debe ser un arreglo');
  }
  if (!Array.isArray(criterios.reglas)) {
    errores.push('reglas debe ser un arreglo');
    return errores;
  }
  const ids = new Set();
  criterios.reglas.forEach((r, i) => {
    const p = `reglas[${i}]`;
    if (!r.id) errores.push(`${p}: falta id`);
    else if (ids.has(r.id)) errores.push(`${p}: id duplicado "${r.id}"`);
    ids.add(r.id);
    if (!r.campo) errores.push(`${p}: falta campo`);
    if (!r.motivo) errores.push(`${p}: falta motivo`);
    if (!OPERADORES.has(r.operador)) errores.push(`${p}: operador inválido "${r.operador}"`);
    if (['en', 'no_en'].includes(r.operador) && !Array.isArray(r.valor)) {
      errores.push(`${p}: "${r.operador}" requiere un arreglo`);
    }
    if (r.operador === 'entre' && !(Array.isArray(r.valor) && r.valor.length === 2)) {
      errores.push(`${p}: "entre" requiere [min, max]`);
    }
    if (['mayor_o_igual', 'menor_o_igual'].includes(r.operador) && typeof r.valor !== 'number') {
      errores.push(`${p}: "${r.operador}" requiere un número`);
    }
  });
  return errores;
}

/**
 * @param {object} p
 * @param {object} p.criterios               roles_agente.criterios
 * @param {boolean} p.requiereVerificacionDireccion  roles_agente.requiere_verificacion_direccion
 * @param {object} p.datos                   datos capturados del contacto
 * @param {object|null} p.verificacionDireccion  última fila de verificaciones_direccion
 *        ({ resultado: 'verificada'|'ambigua'|'no_verificada'|'error', ... })
 * @returns {{ resultado, accion, campos_faltantes, reglas, motivo, codigo_motivo }}
 */
function evaluarCalificacion({ criterios, requiereVerificacionDireccion, datos, verificacionDireccion }) {
  const errores = validarCriterios(criterios);
  if (errores.length) {
    throw new Error(`Criterios inválidos: ${errores.join('; ')}`);
  }

  const datosSeguros = datos || {};
  const faltantes = criterios.campos_obligatorios.filter((c) => !estaPresente(obtener(datosSeguros, c)));

  const base = { campos_faltantes: faltantes, reglas: [], motivo: null, codigo_motivo: null };

  // 1. Información mínima (AC 10: no se inventan datos; se piden).
  if (faltantes.length) {
    return {
      ...base,
      resultado: RESULTADO.INFORMACION_INCOMPLETA,
      accion: ACCION.SOLICITAR_DATOS,
      codigo_motivo: 'campos_faltantes',
      motivo: `Faltan campos obligatorios: ${faltantes.join(', ')}`,
    };
  }

  // 2. Verificación de dirección, solo para roles que la exigen (Lucía).
  if (requiereVerificacionDireccion) {
    const r = verificacionDireccion && verificacionDireccion.resultado;
    if (!r) {
      return {
        ...base,
        resultado: RESULTADO.INFORMACION_INCOMPLETA,
        accion: ACCION.VERIFICAR_DIRECCION,
        codigo_motivo: 'direccion_sin_verificar',
        motivo: 'La dirección aún no se ha consultado en Google Maps',
      };
    }
    if (r === 'ambigua') {
      return {
        ...base,
        resultado: RESULTADO.INFORMACION_INCOMPLETA,
        accion: ACCION.ACLARAR_DIRECCION,
        codigo_motivo: 'direccion_ambigua',
        motivo: 'La dirección es ambigua; se solicita ciudad, barrio, referencia o corrección',
      };
    }
    if (r === 'error') {
      // AC 47: una falla del proveedor no descarta al contacto.
      return {
        ...base,
        resultado: RESULTADO.INFORMACION_INCOMPLETA,
        accion: ACCION.REINTENTAR_VERIFICACION,
        codigo_motivo: 'error_verificacion',
        motivo: 'Falló la consulta a Google Maps; se debe reintentar',
      };
    }
    if (r === 'no_verificada') {
      // AC 16: no se califica automáticamente.
      return {
        ...base,
        resultado: RESULTADO.NO_CALIFICADO,
        accion: ACCION.ARCHIVAR,
        codigo_motivo: 'direccion_no_verificada',
        motivo: 'La dirección no pudo verificarse como una ubicación real',
      };
    }
  }

  // 3. Reglas de negocio configuradas. Se evalúan todas para dejar trazabilidad.
  const reglas = criterios.reglas.map((regla) => {
    const valor = obtener(datosSeguros, regla.campo);
    return { id: regla.id, campo: regla.campo, valor, cumple: cumpleRegla(regla, valor), motivo: regla.motivo };
  });
  const incumplidas = reglas.filter((r) => !r.cumple);

  if (incumplidas.length) {
    return {
      ...base,
      reglas,
      resultado: RESULTADO.NO_CALIFICADO,
      accion: ACCION.ARCHIVAR,
      codigo_motivo: incumplidas.map((r) => r.id).join(','),
      motivo: incumplidas.map((r) => r.motivo).join('; '),
    };
  }

  return {
    ...base,
    reglas,
    resultado: RESULTADO.CALIFICADO,
    accion: ACCION.OFRECER_AGENDA,
  };
}

module.exports = { evaluarCalificacion, validarCriterios, normalizarTexto, RESULTADO, ACCION };
