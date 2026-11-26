'use client';

import { useActionState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { enviarEnlace, type EstadoLogin } from './actions';

function FormularioLogin() {
  const [estado, accion, pendiente] = useActionState<EstadoLogin, FormData>(enviarEnlace, { enviado: false });
  const errorEnlace = useSearchParams().get('error');

  if (estado.enviado) {
    return (
      <p className="aviso ok">
        Si tu correo está autorizado, te llegó un enlace para entrar. Ábrelo en este mismo navegador.
      </p>
    );
  }

  return (
    <form action={accion}>
      {errorEnlace && <p className="aviso mal">El enlace venció o ya se usó. Pide uno nuevo.</p>}
      <label htmlFor="email">Correo</label>
      <input id="email" name="email" type="email" autoComplete="email" required autoFocus />
      {estado.error && <p className="aviso mal">{estado.error}</p>}
      <button className="principal" type="submit" disabled={pendiente}>
        {pendiente ? 'Enviando…' : 'Enviarme el enlace de acceso'}
      </button>
    </form>
  );
}

export default function PaginaLogin() {
  return (
    <div className="centro">
      <div className="tarjeta">
        <h2>Panel del agente</h2>
        <p>Entra con el correo autorizado. Te enviamos un enlace, sin contraseña.</p>
        <Suspense>
          <FormularioLogin />
        </Suspense>
      </div>
    </div>
  );
}
