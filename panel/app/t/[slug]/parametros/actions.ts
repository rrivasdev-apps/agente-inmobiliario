'use server';

import { revalidatePath } from 'next/cache';
import { cargarTenant } from '@/lib/tenant';
import { calcularCambios } from '@/lib/parametros';

export interface EstadoGuardado {
  tipo: 'ok' | 'mal' | 'info';
  mensaje: string;
  errores: Record<string, string>;
}

export async function guardarParametros(slug: string, formulario: FormData): Promise<EstadoGuardado> {
  // Se vuelven a leer los parámetros al guardar: solo se envía lo que de verdad cambió.
  const { supabase, tenant, esAdmin } = await cargarTenant(slug);
  if (!esAdmin) return { tipo: 'mal', mensaje: 'Tu acceso es de solo lectura.', errores: {} };

  // El formulario no sube archivos: cualquier File se ignora como texto vacío.
  const comoTexto = (valor: FormDataEntryValue | null) => (typeof valor === 'string' ? valor : null);
  const { cambios, errores } = calcularCambios(tenant.parametros, {
    get: (nombre) => comoTexto(formulario.get(nombre)),
    getAll: (nombre) => formulario.getAll(nombre).filter((valor): valor is string => typeof valor === 'string'),
  });
  if (Object.keys(errores).length) {
    return { tipo: 'mal', mensaje: 'Revisa los campos marcados. No se guardó nada.', errores };
  }
  const total = Object.keys(cambios).length;
  if (!total) return { tipo: 'info', mensaje: 'No hay cambios que guardar.', errores: {} };

  const { error } = await supabase.rpc('actualizar_parametros', { p_tenant: tenant.id, p_cambios: cambios });
  if (error) return { tipo: 'mal', mensaje: `No se pudo guardar: ${error.message}`, errores: {} };

  revalidatePath(`/t/${slug}`, 'layout');
  return {
    tipo: 'ok',
    mensaje: `Listo: ${total === 1 ? '1 cambio guardado' : `${total} cambios guardados`}. El agente lo usa desde el próximo mensaje.`,
    errores: {},
  };
}
