import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function variablesSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const clave = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !clave) {
    throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (ver panel/.env.example)');
  }
  return { url, clave };
}

// Cliente con la sesión de quien está en el panel: todo lo que lee o escribe
// pasa por RLS y por la membresía en app.miembros_tenant. Nunca usa service_role.
export async function crearClienteServidor() {
  const almacenCookies = await cookies();
  const { url, clave } = variablesSupabase();
  return createServerClient(url, clave, {
    db: { schema: 'app' },
    cookies: {
      getAll: () => almacenCookies.getAll(),
      setAll(cookiesPorGuardar) {
        try {
          for (const { name, value, options } of cookiesPorGuardar) {
            almacenCookies.set(name, value, options);
          }
        } catch {
          // Desde un Server Component no se pueden escribir cookies; el proxy
          // ya renueva la sesión en cada petición.
        }
      },
    },
  });
}
