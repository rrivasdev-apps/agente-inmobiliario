import { notFound, redirect } from 'next/navigation';
import { crearClienteServidor } from './supabase/server';
import type { Json } from './parametros';

export interface Tenant {
  id: string;
  slug: string;
  nombre: string;
  zona_horaria: string;
  parametros: Json;
}

export async function usuarioActual() {
  const supabase = await crearClienteServidor();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect('/login');
  return { supabase, usuario: { id: claims.sub, email: (claims.email as string | undefined) ?? '' } };
}

/**
 * Carga el tenant del slug si quien entra es miembro. RLS ya oculta los tenants
 * ajenos; si no aparece, se responde 404 para no revelar que existe.
 */
export async function cargarTenant(slug: string) {
  const { supabase, usuario } = await usuarioActual();

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, slug, nombre, zona_horaria, parametros')
    .eq('slug', slug)
    .maybeSingle<Tenant>();
  if (error) throw new Error(`No se pudo leer el tenant: ${error.message}`);
  if (!tenant) notFound();

  const { data: membresia } = await supabase
    .from('miembros_tenant')
    .select('rol')
    .eq('tenant_id', tenant.id)
    .eq('user_id', usuario.id)
    .maybeSingle<{ rol: string }>();
  if (!membresia) notFound();

  // Mismo criterio que app.es_admin_de en la BD, que es quien decide de verdad.
  const esAdmin = ['admin_plataforma', 'admin_operacion'].includes(membresia.rol);
  return { supabase, usuario, tenant, rol: membresia.rol, esAdmin };
}

export function normalizarTexto(texto: string) {
  // Igual que app.normalizar_texto, para buscar barrios por nombre_normalizado.
  return texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
