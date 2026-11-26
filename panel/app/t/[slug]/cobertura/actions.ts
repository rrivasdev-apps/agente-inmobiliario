'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cargarTenant } from '@/lib/tenant';

// Las escrituras pasan por RLS (ciudades_cobertura_escritura_admin): aunque
// alguien llame a la acción sin ser admin, la BD no cambia nada.

function volver(slug: string, aviso: string) {
  revalidatePath(`/t/${slug}/cobertura`);
  redirect(`/t/${slug}/cobertura?aviso=${aviso}`);
}

export async function agregarCiudad(slug: string, formulario: FormData) {
  const { supabase, tenant, esAdmin } = await cargarTenant(slug);
  const ciudad = String(formulario.get('ciudad') ?? '').trim().replace(/\s+/g, ' ');
  if (!esAdmin || !ciudad) volver(slug, 'ciudad_invalida');

  const { error } = await supabase.from('ciudades_cobertura').insert({ tenant_id: tenant.id, ciudad });
  // 23505: ya existe (quizá desactivada); se reactiva en lugar de duplicarla.
  if (error?.code === '23505') {
    await supabase.from('ciudades_cobertura').update({ activa: true }).eq('tenant_id', tenant.id).eq('ciudad', ciudad);
  } else if (error) {
    volver(slug, 'error');
  }
  volver(slug, 'ciudad_agregada');
}

export async function cambiarCiudad(slug: string, id: string, activa: boolean) {
  const { supabase, tenant, esAdmin } = await cargarTenant(slug);
  if (!esAdmin) volver(slug, 'error');
  // Se desactiva en lugar de borrar: el seed volvería a sembrar una ciudad borrada.
  const { error } = await supabase.from('ciudades_cobertura').update({ activa }).eq('tenant_id', tenant.id).eq('id', id);
  volver(slug, error ? 'error' : activa ? 'ciudad_activada' : 'ciudad_desactivada');
}
