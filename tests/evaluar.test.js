'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluarCalificacion, validarCriterios } = require('../src/calificacion/evaluar');

const rolesDir = path.join(__dirname, '..', 'config', 'tenants', 'javier-nunez', 'roles');
const lucia = require(path.join(rolesDir, 'lucia.json'));
const sonia = require(path.join(rolesDir, 'sonia.json'));

const evaluarLucia = (datos, verificacionDireccion) => evaluarCalificacion({
  criterios: lucia.criterios,
  requiereVerificacionDireccion: lucia.requiere_verificacion_direccion,
  datos,
  verificacionDireccion,
});

const evaluarSonia = (datos) => evaluarCalificacion({
  criterios: sonia.criterios,
  requiereVerificacionDireccion: sonia.requiere_verificacion_direccion,
  datos,
  verificacionDireccion: null,
});

const propietario = {
  nombre: 'Ana Pérez',
  telefono: '+573001112233',
  ciudad: 'Bogota',
  barrio: 'Chapinero',
  direccion: 'Calle 63 # 9-15',
  tipo_inmueble: 'Apartamento',
  relacion_inmueble: 'propietario',
  intencion_venta: true,
};

const comprador = {
  nombre: 'Luis Gómez',
  telefono: '+573004445566',
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
});

test('Lucía: intencion_venta=false cuenta como dato presente y no califica', () => {
  const r = evaluarLucia({ ...propietario, intencion_venta: false }, { resultado: 'verificada' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'intencion_venta');
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
  assert.equal(r.codigo_motivo, 'relacion_valida,mercado_ciudad');
  assert.match(r.motivo, /relación declarada/);
  assert.match(r.motivo, /fuera del mercado/);
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

test('Sonia: un texto sin número no cumple reglas numéricas de máximo', () => {
  const r = evaluarSonia({ ...comprador, horizonte_compra_meses: 'pronto' });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'horizonte_compra');
});

// PRD §9.8 prueba 7
test('Sonia: sin intención concreta no califica', () => {
  const r = evaluarSonia({ ...comprador, intencion_compra: false });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.codigo_motivo, 'intencion_compra');
});

test('Sonia: solo califica si cumple TODOS los criterios (AC 21)', () => {
  const r = evaluarSonia({ ...comprador, horizonte_compra_meses: 12 });
  assert.equal(r.resultado, 'no_calificado');
  assert.equal(r.reglas.filter((x) => !x.cumple).length, 1);
});
