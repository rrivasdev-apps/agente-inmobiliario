import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { crearClienteServidor } from '@/lib/supabase/server';

// Destino del enlace del correo. Acepta los dos formatos de Supabase: ?code=
// (plantilla por defecto, PKCE) y ?token_hash=&type= (plantilla personalizada).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const tipo = searchParams.get('type') as EmailOtpType | null;

  const supabase = await crearClienteServidor();
  let error: unknown = 'sin código';
  if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else if (tokenHash && tipo) {
    ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: tipo }));
  }

  return NextResponse.redirect(new URL(error ? '/login?error=enlace' : '/', origin));
}
