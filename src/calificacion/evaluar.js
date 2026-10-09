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
 *   "campos_obligatorios": ["nombre", { "campo": "presupuesto_cop", "si": { "campo": "operacion", "valor": "compra" } }],
 *   "reglas": [
 *     { "id": "intencion", "campo": "intencion_venta", "operador": "igual",
 *       "valor": true, "motivo": "No manifestó intención de vender" },
 *     { "id": "presupuesto", "campo": "presupuesto_cop", "operador": "mayor_o_igual",
 *       "parametro": "compra.presupuesto_minimo_cop", "si": { "campo": "operacion", "valor": "compra" },
 *       "motivo": "Presupuesto por debajo del mínimo" }
 *   ],
 *   "prioridad": { "campo": "plazo_meses", "parametro": "prioridad.alta_hasta_meses" }
 * }
 *
 * - `si`: la regla o el campo obligatorio solo aplica cuando otro dato tiene
 *   ese valor (o uno de los valores de un arreglo).
 * - `parametro`: el valor sale de los parámetros del tenant (ruta con puntos).
 *   Si el parámetro está vacío (null), la regla no se aplica.
 * - `prioridad`: quien cumple los criterios es "alta" si el plazo (en meses)
 *   es menor o igual al umbral, y "baja" si no. Alta -> ofrecer agenda;
 *   baja -> nutrir (no se agenda).
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
  NUTRIR: 'nutrir',
  ARCHIVAR: 'archivar',
});

const PRIORIDAD = Object.freeze({ ALTA: 'alta', BAJA: 'baja' });

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

/** ¿Aplica la condición `si` con estos datos? Sin condición, siempre aplica. */
function aplica(si, datos) {
  if (!si) return true;
  const valor = normalizar(obtener(datos, si.campo));
  const esperados = Array.isArray(si.valor) ? si.valor : [si.valor];
  return esperados.map(normalizar).includes(valor);
}

function campoObligatorio(c) {
  return typeof c === 'string' ? { campo: c, si: null } : c;
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

function validarValor(r, p) {
  const errores = [];
  if (['en', 'no_en'].includes(r.operador) && !Array.isArray(r.valor)) {
    errores.push(`${p}: "${r.operador}" requiere un arreglo`);
  }
  if (r.operador === 'entre' && !(Array.isArray(r.valor) && r.valor.length === 2)) {
    errores.push(`${p}: "entre" requiere [min, max]`);
  }
  if (['mayor_o_igual', 'menor_o_igual'].includes(r.operador) && typeof r.valor !== 'number') {
    errores.push(`${p}: "${r.operador}" requiere un número`);
  }
  return errores;
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
  } else {
    criterios.campos_obligatorios.forEach((c, i) => {
      if (typeof c === 'string') return;
      if (!c || !c.campo || !c.si || !c.si.campo) errores.push(`campos_obligatorios[${i}]: requiere campo y si.campo`);
    });
  }
  if (criterios.prioridad !== undefined) {
    const pr = criterios.prioridad;
    if (!pr || !pr.campo) errores.push('prioridad: falta campo');
    else if (pr.parametro === undefined && typeof pr.valor !== 'number') errores.push('prioridad: requiere valor numérico o parametro');
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
    if (r.si && !r.si.campo) errores.push(`${p}: si requiere campo`);
    if (r.parametro !== undefined) {
      if (typeof r.parametro !== 'string' || !r.parametro) errores.push(`${p}: parametro debe ser una ruta`);
      return; // el valor se valida al evaluar, con los parámetros del tenant
    }
    errores.push(...validarValor(r, p));
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
 * @param {object} [p.parametros]            app.tenants.parametros (para `parametro`)
 * @returns {{ resultado, accion, prioridad, campos_faltantes, reglas, motivo, codigo_motivo }}
 */
function evaluarCalificacion({ criterios, requiereVerificacionDireccion, datos, verificacionDireccion, parametros = {} }) {
  const errores = validarCriterios(criterios);
  if (errores.length) {
    throw new Error(`Criterios inválidos: ${errores.join('; ')}`);
  }

  const datosSeguros = datos || {};
  const faltantes = criterios.campos_obligatorios
    .map(campoObligatorio)
    .filter((c) => aplica(c.si, datosSeguros))
    .map((c) => c.campo)
    .filter((c) => !estaPresente(obtener(datosSeguros, c)));

  const base = { campos_faltantes: faltantes, reglas: [], prioridad: null, motivo: null, codigo_motivo: null };

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
  // Las reglas que no aplican (condición `si`) o cuyo parámetro está vacío se omiten.
  const reglas = criterios.reglas
    .filter((regla) => aplica(regla.si, datosSeguros))
    .map((regla) => (regla.parametro === undefined ? regla : { ...regla, valor: obtener(parametros || {}, regla.parametro) }))
    .filter((regla) => regla.valor !== undefined && regla.valor !== null)
    .map((regla) => {
      const errores = validarValor(regla, `regla ${regla.id}`);
      if (errores.length) throw new Error(`Parámetro inválido: ${errores.join('; ')}`);
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

  // 4. Prioridad: quien califica se agenda si es urgente; si no, se nutre.
  const prioridad = calcularPrioridad(criterios.prioridad, datosSeguros, parametros);
  return {
    ...base,
    reglas,
    prioridad,
    resultado: RESULTADO.CALIFICADO,
    accion: prioridad === PRIORIDAD.BAJA ? ACCION.NUTRIR : ACCION.OFRECER_AGENDA,
  };
}

/** Sin configuración de prioridad, o sin plazo legible, todo calificado es alta. */
function calcularPrioridad(config, datos, parametros) {
  if (!config) return PRIORIDAD.ALTA;
  const umbral = config.parametro !== undefined ? obtener(parametros || {}, config.parametro) : config.valor;
  if (typeof umbral !== 'number') return PRIORIDAD.ALTA;
  const plazo = aNumero(obtener(datos, config.campo));
  if (Number.isNaN(plazo)) return PRIORIDAD.ALTA;
  return plazo <= umbral ? PRIORIDAD.ALTA : PRIORIDAD.BAJA;
}

module.exports = { evaluarCalificacion, validarCriterios, normalizarTexto, RESULTADO, ACCION, PRIORIDAD };
