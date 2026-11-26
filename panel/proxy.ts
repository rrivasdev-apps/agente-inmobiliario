import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const RUTAS_PUBLICAS = ['/login', '/auth'];

// Renueva la sesión de Supabase en cada petición y manda al login a quien no
// tenga sesión. La autorización por tenant la hace cada página con la membresía.
export async function proxy(request: NextRequest) {
  let respuesta = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesPorGuardar, encabezados) {
          for (const { name, value } of cookiesPorGuardar) request.cookies.set(name, value);
          respuesta = NextResponse.next({ request });
          for (const { name, value, options } of cookiesPorGuardar) {
            respuesta.cookies.set(name, value, options);
          }
          // Evita que un CDN guarde en caché una respuesta con cookies de sesión.
          for (const [clave, valor] of Object.entries(encabezados ?? {})) {
            respuesta.headers.set(clave, valor);
          }
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const conSesion = Boolean(data?.claims?.sub);
  const esPublica = RUTAS_PUBLICAS.some((ruta) => request.nextUrl.pathname.startsWith(ruta));

  if (!conSesion && !esPublica) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return respuesta;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
