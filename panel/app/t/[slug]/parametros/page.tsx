import { cargarTenant } from '@/lib/tenant';
import { leerRuta, seccionesDisponibles, type Json } from '@/lib/parametros';
import { FormularioParametros } from './formulario';

export default async function PaginaParametros({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { tenant, esAdmin } = await cargarTenant(slug);

  const secciones = seccionesDisponibles(tenant.parametros);
  const valores: Record<string, Json | undefined> = {};
  for (const campo of secciones.flatMap((seccion) => seccion.campos)) {
    valores[campo.ruta] = leerRuta(tenant.parametros, campo.ruta);
  }

  return (
    <>
      <h1>Parámetros del agente</h1>
      <p className="subtitulo">Los cambios se aplican desde el próximo mensaje que reciban Lucía y Sonia.</p>
      <FormularioParametros slug={slug} secciones={secciones} valores={valores} soloLectura={!esAdmin} />
    </>
  );
}
