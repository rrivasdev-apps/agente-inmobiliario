import Link from 'next/link';
import { verificarEnlace } from './actions';

// Destino del enlace del correo. No inicia sesión al abrirse: Gmail y otros
// revisan los enlaces automáticamente y gastarían el enlace de un solo uso.
// La sesión empieza cuando la persona pulsa "Entrar".
export default async function ConfirmarEnlace({ searchParams }: {
  searchParams: Promise<{ token_hash?: string; type?: string }>;
}) {
  const { token_hash: tokenHash = '', type: tipo = 'email' } = await searchParams;

  return (
    <div className="centro">
      <div className="tarjeta">
        <h2>Panel del agente</h2>
        {tokenHash ? (
          <form action={verificarEnlace.bind(null, tokenHash, tipo)}>
            <p>Pulsa el botón para entrar.</p>
            <button className="principal" type="submit">Entrar</button>
          </form>
        ) : (
          <>
            <p className="aviso mal">Este enlace no es válido.</p>
            <p><Link href="/login">Pedir un enlace nuevo</Link></p>
          </>
        )}
      </div>
    </div>
  );
}
