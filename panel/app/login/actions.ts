'use server';

import { crearClienteServidor } from '@/lib/supabase/server';

export interface EstadoLogin {
  enviado: boolean;
  error?: string;
}

export async function enviarEnlace(_previo: EstadoLogin, formulario: FormData): Promise<EstadoLogin> {
  const email = String(formulario.get('email') ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { enviado: false, error: 'Escribe un correo válido.' };
  }

  const supabase = await crearClienteServidor();
  const sitio = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3100';
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Solo entran cuentas creadas por el administrador de la plataforma:
      // un correo desconocido no crea usuario.
      shouldCreateUser: false,
      emailRedirectTo: `${sitio}/auth/confirm`,
    },
  });

  // El límite y las fallas del servidor de correo sí se informan; un correo no
  // registrado (error 4xx) se responde igual que un envío, para no revelar quién tiene cuenta.
  if (error?.status === 429) {
    return { enviado: false, error: 'Se pidieron demasiados enlaces. Espera unos minutos e intenta de nuevo.' };
  }
  if (error && (error.status ?? 500) >= 500) {
    console.error('No se pudo enviar el enlace de acceso:', error.message);
    return { enviado: false, error: 'No pudimos enviar el correo en este momento. Intenta de nuevo más tarde.' };
  }
  return { enviado: true };
}
