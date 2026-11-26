'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SECCIONES = [
  { ruta: 'parametros', titulo: 'Parámetros' },
  { ruta: 'cobertura', titulo: 'Cobertura' },
  { ruta: 'historial', titulo: 'Historial' },
];

export function Menu({ slug }: { slug: string }) {
  const actual = usePathname();
  return (
    <nav aria-label="Secciones">
      {SECCIONES.map(({ ruta, titulo }) => {
        const href = `/t/${slug}/${ruta}`;
        return (
          <Link key={ruta} href={href} aria-current={actual.startsWith(href) ? 'page' : undefined}>{titulo}</Link>
        );
      })}
    </nav>
  );
}
