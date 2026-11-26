import Link from 'next/link';
import { redirect } from 'next/navigation';
import { usuarioActual } from '@/lib/tenant';
import { cerrarSesion } from './sesion';

// Inicio: lleva al tenant de la persona. Con varios (administrador de la
// plataforma, futuro SaaS) muestra la lista.
export default async function Inicio() {
  const { supabase, usuario } = await usuarioActual();
  const { data: tenants, error } = await supabase.from('tenants').select('slug, nombre').order('nombre');
  if (error) throw new Error(`No se pudieron leer los tenants: ${error.message}`);

  if (tenants?.length === 1) redirect(`/t/${tenants[0].slug}/parametros`);

  return (
    <div className="centro">
      <div className="tarjeta">
        <h2>Panel del agente</h2>
        {tenants?.length ? (
          <ul>
            {tenants.map((tenant) => (
              <li key={tenant.slug}><Link href={`/t/${tenant.slug}/parametros`}>{tenant.nombre}</Link></li>
            ))}
          </ul>
        ) : (
          <p>Tu correo ({usuario.email}) entró, pero aún no tiene acceso a ningún agente. Pídele acceso al administrador.</p>
        )}
        <form action={cerrarSesion}><button className="enlace" type="submit">Salir</button></form>
      </div>
    </div>
  );
}
