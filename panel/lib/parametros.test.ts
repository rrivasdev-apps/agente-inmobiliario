import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularCambios, leerRuta, seccionesDisponibles, type Json } from './parametros.ts';

function formulario(valores: Record<string, string | string[]>) {
  return {
    get: (nombre: string) => {
      const valor = valores[nombre];
      return Array.isArray(valor) ? valor[0] ?? null : valor ?? null;
    },
    getAll: (nombre: string) => {
      const valor = valores[nombre];
      return valor === undefined ? [] : Array.isArray(valor) ? valor : [valor];
    },
  };
}

const parametros: Json = {
  propietarios: { valor_minimo_cop: 450000000, tolerancia_valor_pct: 10, valor_premium_cop: 1000000000,
    relaciones_validas: ['propietario'] },
  arriendo: { canon_minimo_cop: null },
  dossier: { lucia: null },
  conversacion: { cierre_inactividad_horas: 48, retraso_escritura: { minimo_s: 2, maximo_s: 8, caracteres_por_segundo: 30 } },
  reporte_no_calificados: { activo: true, dias: 7, destinatarios: [] },
};

const sinCambios = {
  'propietarios.valor_minimo_cop': '450.000.000',
  'propietarios.tolerancia_valor_pct': '10',
  'propietarios.valor_premium_cop': '1.000.000.000',
  'propietarios.relaciones_validas': ['propietario'],
  'arriendo.canon_minimo_cop': '',
  'dossier.lucia.url': '',
  'conversacion.cierre_inactividad_horas': '48',
  'conversacion.retraso_escritura.minimo_s': '2',
  'conversacion.retraso_escritura.maximo_s': '8',
  'conversacion.retraso_escritura.caracteres_por_segundo': '30',
  'reporte_no_calificados.activo': 'on',
  'reporte_no_calificados.dias': '7',
  'reporte_no_calificados.destinatarios': '',
};

test('leerRuta distingue una ruta inexistente de un valor nulo', () => {
  assert.equal(leerRuta(parametros, 'arriendo.canon_minimo_cop'), null);
  assert.equal(leerRuta(parametros, 'arriendo.otro'), undefined);
});

test('solo muestra los campos que existen en el tenant', () => {
  const rutas = seccionesDisponibles(parametros).flatMap((seccion) => seccion.campos.map((campo) => campo.ruta));
  assert.ok(rutas.includes('propietarios.valor_minimo_cop'));
  assert.ok(!rutas.includes('compra.presupuesto_minimo_cop'));
});

test('el formulario igual a lo guardado no genera cambios', () => {
  assert.deepEqual(calcularCambios(parametros, formulario(sinCambios)), { cambios: {}, errores: {} });
});

test('interpreta pesos, porcentajes, casillas, listas y dossier', () => {
  const { cambios, errores } = calcularCambios(parametros, formulario({
    ...sinCambios,
    'propietarios.valor_minimo_cop': '$500,000,000',
    'propietarios.tolerancia_valor_pct': '',
    'arriendo.canon_minimo_cop': '3 000 000',
    'reporte_no_calificados.activo': [],
    'reporte_no_calificados.destinatarios': ' a@b.co \n\n c@d.co ',
    'dossier.lucia.url': 'https://ejemplo.co/archivos/JNdelT.pdf',
  }));
  assert.deepEqual(errores, {});
  assert.deepEqual(cambios, {
    'propietarios.valor_minimo_cop': 500000000,
    'propietarios.tolerancia_valor_pct': null,
    'arriendo.canon_minimo_cop': 3000000,
    'reporte_no_calificados.activo': false,
    'reporte_no_calificados.destinatarios': ['a@b.co', 'c@d.co'],
    'dossier.lucia': { url: 'https://ejemplo.co/archivos/JNdelT.pdf', nombre_archivo: 'JNdelT.pdf' },
  });
});

test('rechaza valores inválidos con un mensaje por campo', () => {
  const { cambios, errores } = calcularCambios(parametros, formulario({
    ...sinCambios,
    'propietarios.valor_premium_cop': '',
    'propietarios.tolerancia_valor_pct': '150',
    'propietarios.relaciones_validas': [],
    'conversacion.cierre_inactividad_horas': '1.5',
    'conversacion.retraso_escritura.maximo_s': '1',
    'reporte_no_calificados.destinatarios': 'sin-arroba',
    'dossier.lucia.url': 'http://inseguro.co/a.pdf',
  }));
  assert.deepEqual(Object.keys(errores).sort(), [
    'conversacion.cierre_inactividad_horas',
    'conversacion.retraso_escritura.maximo_s',
    'dossier.lucia',
    'propietarios.relaciones_validas',
    'propietarios.tolerancia_valor_pct',
    'propietarios.valor_premium_cop',
    'reporte_no_calificados.destinatarios',
  ]);
  assert.ok(!('propietarios.valor_premium_cop' in cambios));
});
