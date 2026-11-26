import type { Campo, Json } from './parametros';

const pesos = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

export function formatearPesos(numero: number) {
  return `$ ${pesos.format(numero)}`;
}

/** Cómo se muestra un valor guardado (historial y vistas de solo lectura). */
export function formatearValor(campo: Campo | undefined, valor: Json | undefined): string {
  if (valor === null || valor === undefined) return '—';
  if (typeof valor === 'boolean') return valor ? 'Sí' : 'No';
  if (typeof valor === 'number') {
    if (campo?.tipo === 'cop') return formatearPesos(valor);
    if (campo?.tipo === 'pct') return `${valor} %`;
    return String(valor);
  }
  if (Array.isArray(valor)) return valor.length ? valor.map((item) => formatearValor(undefined, item)).join(', ') : '(vacío)';
  if (typeof valor === 'object') return typeof valor.url === 'string' ? valor.url : JSON.stringify(valor);
  return valor;
}

/** Valor inicial de un campo del formulario. */
export function valorDeFormulario(campo: Campo, valor: Json | undefined): string {
  if (valor === null || valor === undefined) return '';
  if (campo.tipo === 'cop' && typeof valor === 'number') return pesos.format(valor);
  if (Array.isArray(valor)) return valor.join('\n');
  return typeof valor === 'object' ? '' : String(valor);
}
