'use server';

import { redirect } from 'next/navigation';
import type { EmailOtpType } from '@supabase/supabase-js';
import { crearClienteServidor } from '@/lib/supabase/server';

const TIPOS_VALIDOS: EmailOtpType[] = ['email', 'magiclink', 'invite', 'signup', 'recovery'];

// Se verifica con token_hash en el servidor: no depende de una cookie del
// navegador donde se pidió el enlace, así que funciona aunque se abra en otro.
export async function verificarEnlace(tokenHash: string, tipo: string) {
  if (!tokenHash || !TIPOS_VALIDOS.includes(tipo as EmailOtpType)) redirect('/login?error=enlace');

  const supabase = await crearClienteServidor();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: tipo as EmailOtpType });
  if (error) {
    console.error('No se pudo verificar el enlace de acceso:', error.message);
    redirect('/login?error=enlace');
  }
  redirect('/');
}
