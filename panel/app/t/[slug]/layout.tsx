import { cargarTenant } from '@/lib/tenant';
import { cerrarSesion } from '@/app/sesion';
import { Menu } from './menu';

export default async function LayoutTenant({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { tenant, usuario, esAdmin } = await cargarTenant(slug);

  return (
    <>
      <header className="barra">
        <span className="marca">{tenant.nombre}</span>
        <Menu slug={tenant.slug} />
        <div className="sesion">
          <span>{usuario.email}{esAdmin ? '' : ' (solo lectura)'}</span>
          <form action={cerrarSesion}><button className="enlace" type="submit">Salir</button></form>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
