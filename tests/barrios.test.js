'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepararSincronizacion, resolverBarrio, parsearCsv } = require('../src/cobertura/barrios');

const csv = fs.readFileSync(path.join(__dirname, '..', 'config', 'tenants', 'javier-nunez', 'barrios.csv'), 'utf8');
const { filas: barrios, advertencias } = prepararSincronizacion(parsearCsv(csv));

test('la hoja de hoy coincide con su hoja Resumen: 447 barrios, 114 Sí, 333 No', () => {
  assert.equal(barrios.length, 447);
  assert.equal(barrios.filter((b) => b.atiende === true).length, 114);
  assert.equal(barrios.filter((b) => b.atiende === false).length, 333);
});

test('la hoja de hoy avisa los nombres truncados para corregirlos', () => {
  const truncados = advertencias.filter((a) => /truncado/.test(a.mensaje));
  assert.equal(truncados.length, 5);
  assert.ok(truncados.every((a) => a.fila > 1 && /Santa Bárbara/.test(a.barrio)));
});

test('prepararSincronizacion: Sí, No y vacío; valores inválidos y filas incompletas', () => {
  const { filas, advertencias: avisos } = prepararSincronizacion([
    { Localidad: 'Suba', 'Cód. UPZ': '20', UPZ: 'La Alhambra', Barrio: 'Pasadena', '¿Lo atiendo? (Sí/No)': 'Sí', 'Mis notas': '  ' },
    { Localidad: 'Suba', 'Cód. UPZ': 24, UPZ: 'Niza', Barrio: 'Niza Sur', '¿Lo atiendo? (Sí/No)': 'no' },
    { Localidad: 'Suba', 'Cód. UPZ': 24, UPZ: 'Niza', Barrio: 'Lagos de Córdoba', '¿Lo atiendo? (Sí/No)': '' },
    { Localidad: 'Suba', 'Cód. UPZ': 24, UPZ: 'Niza', Barrio: 'Calatayud', '¿Lo atiendo? (Sí/No)': 'tal vez' },
    { Localidad: 'Suba', 'Cód. UPZ': '', UPZ: 'Niza', Barrio: 'Sin código' },
    { Localidad: '', 'Cód. UPZ': '', UPZ: '', Barrio: '' },
    { Localidad: 'Usaquén', 'Cód. UPZ': 13, UPZ: 'Los Cedros', Barrio: 'Los Cedros', '¿Lo atiendo? (Sí/No)': 'Sí', Alias: 'Cedritos, Cedros' },
  ]);
  assert.deepEqual(filas.map((f) => [f.barrio, f.atiende]), [
    ['Pasadena', true], ['Niza Sur', false], ['Lagos de Córdoba', null], ['Calatayud', null], ['Los Cedros', true],
  ]);
  assert.equal(filas[0].codigo_upz, 20);
  assert.equal(filas[0].notas, null);
  assert.deepEqual(filas[4].alias, ['Cedritos', 'Cedros']);
  assert.deepEqual(avisos.map((a) => a.fila), [5, 6]);
  assert.match(avisos[0].mensaje, /tal vez/);
  assert.match(avisos[1].mensaje, /Código de UPZ/);
});

test('prepararSincronizacion: un barrio repetido en la misma UPZ deja la última fila', () => {
  const { filas, advertencias: avisos } = prepararSincronizacion([
    { Localidad: 'Suba', 'Cód. UPZ': 24, Barrio: 'Iberia', '¿Lo atiendo?': 'No' },
    { Localidad: 'Suba', 'Cód. UPZ': 24, Barrio: 'IBERIA ', '¿Lo atiendo?': 'Sí' },
  ]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].atiende, true);
  assert.match(avisos[0].mensaje, /repetido/);
});

test('parsearCsv respeta comillas, comas y saltos de línea dentro de un campo', () => {
  const filas = parsearCsv('Barrio,Mis notas\r\n"Rincón, del Chicó","solo ""conjuntos""\ncerrados"\r\n');
  assert.deepEqual(filas, [{ Barrio: 'Rincón, del Chicó', 'Mis notas': 'solo "conjuntos"\ncerrados' }]);
});

test('resolverBarrio: coincidencia exacta sin importar tildes, mayúsculas ni prefijos', () => {
  assert.equal(resolverBarrio('pasadena', barrios).estado, 'atendido');
  assert.equal(resolverBarrio('Barrio Mazuren', barrios).estado, 'atendido');
  assert.equal(resolverBarrio('  LA CASTELLANA. ', barrios).estado, 'atendido');
  const r = resolverBarrio('Canaima', barrios);
  assert.equal(r.estado, 'no_atendido');
  assert.deepEqual(r.candidatos, [{ localidad: 'Usaquén', codigo_upz: 1, upz: 'Paseo de los Libertadores', barrio: 'Canaima', atiende: false }]);
});

test('resolverBarrio: encuentra el barrio dentro de una frase', () => {
  assert.equal(resolverBarrio('en Pasadena, cerca al parque', barrios).estado, 'atendido');
});

test('resolverBarrio: un barrio en dos UPZ con la misma marca no es ambiguo', () => {
  const r = resolverBarrio('La Cabrera', barrios);
  assert.equal(r.estado, 'atendido');
  assert.equal(r.candidatos.length, 2);
});

test('resolverBarrio: nombres repetidos con marca distinta se desambiguan con pistas', () => {
  const datos = [
    { localidad: 'Suba', codigo_upz: 24, upz: 'Niza', barrio: 'Lisboa', atiende: true },
    { localidad: 'Suba', codigo_upz: 71, upz: 'Tibabuyes', barrio: 'Lisboa', atiende: false },
  ];
  assert.equal(resolverBarrio('Lisboa', datos).estado, 'ambiguo');
  assert.equal(resolverBarrio('Lisboa', datos, { upz: 'niza' }).estado, 'atendido');
  assert.equal(resolverBarrio('Lisboa', datos, { upz: 71 }).estado, 'no_atendido');
  // Una pista que no corresponde a ningún candidato no descarta la búsqueda.
  assert.equal(resolverBarrio('Lisboa', datos, { localidad: 'Chapinero' }).estado, 'ambiguo');
});

test('resolverBarrio: alias, barrio geocodificado, sin definir y desconocido', () => {
  const datos = [
    { localidad: 'Usaquén', codigo_upz: 13, upz: 'Los Cedros', barrio: 'Los Cedros', alias: ['Cedritos'], atiende: true },
    { localidad: 'Suba', codigo_upz: 24, upz: 'Niza', barrio: 'Lagos de Córdoba', alias: [], atiende: null },
  ];
  assert.equal(resolverBarrio('cedritos', datos).estado, 'atendido');
  assert.equal(resolverBarrio('cerca al Unicentro', datos, { barrioGeocodificado: 'Cedritos' }).estado, 'atendido');
  assert.equal(resolverBarrio('Lagos de Cordoba', datos).estado, 'sin_definir');
  const r = resolverBarrio('Kennedy', datos);
  assert.equal(r.estado, 'desconocido');
  assert.deepEqual(r.candidatos, []);
  assert.equal(resolverBarrio('', datos).estado, 'desconocido');
});
