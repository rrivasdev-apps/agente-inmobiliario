'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluarCalificacion, validarCriterios } = require('../src/calificacion/evaluar');

const rolesDir = path.join(__dirname, '..', 'config', 'tenants', 'javier-nunez', 'roles');
const lucia = require(path.join(rolesDir, 'lucia.json'));
const sonia = require(path.join(rolesDir, 'sonia.json'));
const { parametros } = require(path.join(rolesDir, '..', 'tenant.json'));

const evaluarLucia = (datos, verificacionDireccion) => evaluarCalificacion({
  criterios: lucia.criterios,
  requiereVerificacionDireccion: lucia.requiere_verificacion_direccion,
  datos,
  verificacionDireccion,
  parametros,
});

const evaluarSonia = (datos) => evaluarCalificacion({
  criterios: sonia.criterios,
  requiereVerificacionDireccion: sonia.requiere_verificacion_direccion,
  datos,
  verificacionDireccion: null,
  parametros,
});

const propietario = {
  nombre: 'Ana Pérez',
  telefono: '+573001112233',
  operacion: 'venta',
  ciudad: 'Bogota',
  barrio: 'Chapinero',
  direccion: 'Calle 63 # 9-15',
  tipo_inmueble: 'Apartamento',
  relacion_inmueble: 'propietario',
  intencion_venta: true,
  plazo_meses: 2,
};

const comprador = {
  nombre: 'Luis Gómez',
  telefono: '+573004445566',
  operacion: 'compra',
  ciudad_interes: 'Bogotá',
  tipo_inmueble: 'apartamento',
  presupuesto_cop: 450000000,
  horizonte_compra_meses: 3,
  intencion_compra: true,
};

test('la configuración de ambos roles es válida', () => {
  assert.deepEqual(validarCriterios(lucia.criterios), []);
  assert.deepEqual(validarCriterios(sonia.criterios), []);
});

test('validarCriterios detecta errores de configuración', () => {
  const errores = validarCriterios({
    campos_obligatorios: [],
    reglas: [
      { id: 'a', campo: 'x', operador: 'en', valor: 'no-arreglo', motivo: 'm' },
      { id: 'a', campo: 'y', operador: 'parecido', motivo: 'm' },
      { id: 'b', campo: 'z', operador: 'mayor_o_igual', valor: '10' },
    ],
  });
  assert.equal(errores.length, 5);
});

test('evaluarCalificacion rechaza criterios inválidos en lugar de calificar', () => {
  assert.throws(() => evaluarCalificacion({ criterios: { reglas: [] }, datos: {} }), /Criterios inválidos/);
});

// PRD §9.8 prueba 1
test('Lucía: propietario con dirección verificada califica', () => {
  const r = evaluarLucia(propietario, { resultado: 'verificada' });
  assert.equal(r.resultado, 'calificado');
  assert.equal(r.accion, 'ofrecer_agenda');
  assert.ok(r.reglas.every((x) => x.cumple));
});

test('Lucía: compara texto sin distinguir mayúsculas ni tildes', () => {
  const r = evaluarLucia({ ...propietario, ciudad: '  BOGOTÁ ' }, { resultado: 'verificada' });
  assert.equal(r.resultado, 'calificado');
});

test('Lucía: pide datos faltantes sin inventarlos (AC 10)', () => {
  const { direccion, intencion_venta, ...parcial } = propietario;
  const r = evaluarLucia({ ...parcial, barrio: '   ' }, null);
  assert.equal(r.resultado, 'informacion_incompleta');
  assert.equal(r.accion, 'solicitar_datos');
  assert.deepEqual(r.campos_faltantes, ['barrio', 'direccion', 'intencion_venta']);
  assert.deepEqual(evaluarLucia({ ...propietario, plazo_meses: undefined }, null).campos_faltantes, ['plazo_meses']);
});

test('Lucía: intencion_venta=false cuenta como dato presente y no califica', () => {
  const r = evaluarLucia({ ...propietario, intencion_venta: false }, { resultado: 'verificada' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'intencion_operacion');
});

test('Lucía: no califica sin consultar Google Maps (AC 13)', () => {
  const r = evaluarLucia(propietario, null);
  assert.equal(r.resultado, 'informacion_incompleta');
  assert.equal(r.accion, 'verificar_direccion');
});

// PRD §9.8 prueba 3
test('Lucía: dirección ambigua pide aclaración (AC 15)', () => {
  const r = evaluarLucia(propietario, { resultado: 'ambigua' });
  assert.equal(r.resultado, 'informacion_incompleta');
  assert.equal(r.accion, 'aclarar_direccion');
});

// PRD §9.8 prueba 4
test('Lucía: dirección no verificable no califica automáticamente (AC 16)', () => {
  const r = evaluarLucia(propietario, { resultado: 'no_verificada' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'direccion_no_verificada');
});

test('Lucía: una falla de Google Maps no descarta al contacto (AC 47)', () => {
  const r = evaluarLucia(propietario, { resultado: 'error' });
  assert.equal(r.resultado, 'informacion_incompleta');
  assert.equal(r.accion, 'reintentar_verificacion');
});

test('Lucía: relación no válida y ciudad fuera de mercado registran ambos motivos (AC 43)', () => {
  const r = evaluarLucia({ ...propietario, relacion_inmueble: 'conocido', ciudad: 'Medellín' }, { resultado: 'verificada' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'relacion_valida,cobertura_ciudad');
  assert.match(r.motivo, /relación declarada/);
  assert.match(r.motivo, /fuera de la zona de cobertura/);
});

// PRD §9.8 prueba 5
test('Sonia: comprador dentro de criterios califica sin verificar dirección (AC 20)', () => {
  const r = evaluarSonia(comprador);
  assert.equal(r.resultado, 'calificado');
});

// PRD §9.8 prueba 6
test('Sonia: presupuesto fuera del rango no califica', () => {
  const r = evaluarSonia({ ...comprador, presupuesto_cop: 120000000 });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'presupuesto_minimo');
});

test('Sonia: interpreta presupuesto escrito como texto', () => {
  assert.equal(evaluarSonia({ ...comprador, presupuesto_cop: '$450.000.000' }).resultado, 'calificado');
  assert.equal(evaluarSonia({ ...comprador, presupuesto_cop: '450,000,000' }).resultado, 'calificado');
  assert.equal(evaluarSonia({ ...comprador, presupuesto_cop: 'no sé' }).resultado, 'no_calificado');
});

test('Sonia: un plazo sin número no descarta y se trata como prioridad alta', () => {
  const r = evaluarSonia({ ...comprador, horizonte_compra_meses: 'pronto' });
  assert.equal(r.resultado, 'calificado');
  assert.equal(r.prioridad, 'alta');
});

// PRD §9.8 prueba 7
test('Sonia: sin intención concreta no califica', () => {
  const r = evaluarSonia({ ...comprador, intencion_compra: false });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'intencion_operacion');
});

test('Sonia: solo califica si cumple TODOS los criterios (AC 21)', () => {
  const r = evaluarSonia({ ...comprador, tipo_inmueble: 'otro' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.reglas.filter((x) => !x.cumple).length, 1);
});

// --- Calificación mixta: criterios mínimos y luego prioridad ------------------------

test('prioridad: plazo dentro del umbral agenda; plazo mayor nutre (no descarta)', () => {
  const alta = evaluarSonia({ ...comprador, horizonte_compra_meses: 3 });
  assert.equal(alta.prioridad, 'alta');
  assert.equal(alta.accion, 'ofrecer_agenda');
  const baja = evaluarSonia({ ...comprador, horizonte_compra_meses: 12 });
  assert.equal(baja.resultado, 'calificado');
  assert.equal(baja.prioridad, 'baja');
  assert.equal(baja.accion, 'nutrir');
  assert.equal(evaluarLucia({ ...propietario, plazo_meses: 6 }, { resultado: 'verificada' }).accion, 'nutrir');
});

test('prioridad: el umbral es un parámetro del tenant', () => {
  const r = evaluarCalificacion({
    criterios: sonia.criterios,
    requiereVerificacionDireccion: false,
    datos: { ...comprador, horizonte_compra_meses: 6 },
    parametros: { ...parametros, prioridad: { alta_hasta_meses: 6 } },
  });
  assert.equal(r.prioridad, 'alta');
});

test('no calificado no tiene prioridad', () => {
  assert.equal(evaluarSonia({ ...comprador, intencion_compra: false }).prioridad, null);
});

// --- Arriendo ------------------------------------------------------------------------

const arrendatario = {
  nombre: 'Laura', telefono: '+573007778899', operacion: 'arriendo', ciudad_interes: 'Bogotá',
  tipo_inmueble: 'apartamento', canon_mensual_cop: 2500000, horizonte_compra_meses: 1, intencion_compra: true,
};

test('arriendo: pide canon en lugar de presupuesto y no aplica el mínimo de compra', () => {
  const { canon_mensual_cop, ...sinCanon } = arrendatario;
  assert.deepEqual(evaluarSonia(sinCanon).campos_faltantes, ['canon_mensual_cop']);
  const r = evaluarSonia(arrendatario);
  assert.equal(r.resultado, 'calificado');
  assert.ok(!r.reglas.some((x) => x.id === 'presupuesto_minimo'));
  // Sin canon mínimo configurado (null), la regla se omite.
  assert.ok(!r.reglas.some((x) => x.id === 'canon_minimo'));
});

test('arriendo: con canon mínimo configurado, se aplica', () => {
  const conMinimo = { ...parametros, arriendo: { canon_minimo_cop: 3000000 } };
  const r = evaluarCalificacion({ criterios: sonia.criterios, requiereVerificacionDireccion: false, datos: arrendatario, parametros: conMinimo });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'canon_minimo');
});

test('cobertura: ciudades y tipos salen de los parámetros', () => {
  const ampliada = { ...parametros, cobertura: { ...parametros.cobertura, ciudades: ['Bogotá', 'Chía'] } };
  const r = evaluarCalificacion({ criterios: sonia.criterios, requiereVerificacionDireccion: false, datos: { ...comprador, ciudad_interes: 'chia' }, parametros: ampliada });
  assert.equal(r.resultado, 'calificado');
  assert.equal(evaluarSonia({ ...comprador, ciudad_interes: 'Chía' }).codigo_motivo, 'cobertura_ciudad');
});

test('Lucía en arriendo usa los mismos criterios de cobertura', () => {
  const r = evaluarLucia({ ...propietario, operacion: 'arriendo' }, { resultado: 'verificada' });
  assert.equal(r.resultado, 'calificado');
});

test('validación: obligatorios condicionales y prioridad mal formados', () => {
  const errores = validarCriterios({
    campos_obligatorios: ['a', { campo: 'b' }],
    reglas: [{ id: 'x', campo: 'c', operador: 'mayor_o_igual', parametro: '', motivo: 'm' }],
    prioridad: { campo: 'p' },
  });
  assert.equal(errores.length, 3);
});
