import { cargarTenant } from '@/lib/tenant';
import { SECCIONES, type Json } from '@/lib/parametros';
import { formatearValor } from '@/lib/formato';

interface Cambio {
  id: string; user_id: string | null; ruta: string; valor_anterior: Json; valor_nuevo: Json; creado_en: string;
}

const CAMPOS = new Map(SECCIONES.flatMap((seccion) => seccion.campos).map((campo) => [campo.ruta, campo]));

export default async function PaginaHistorial({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { supabase, tenant, usuario } = await cargarTenant(slug);

  const { data: cambios, error } = await supabase
    .from('cambios_configuracion')
    .select('id, user_id, ruta, valor_anterior, valor_nuevo, creado_en')
    .eq('tenant_id', tenant.id)
    .order('creado_en', { ascending: false })
    .limit(100)
    .returns<Cambio[]>();
  if (error) throw new Error(`No se pudo leer el historial: ${error.message}`);

  const fecha = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short', timeZone: tenant.zona_horaria });

  return (
    <>
      <h1>Historial de cambios</h1>
      <p className="subtitulo">Los últimos 100 cambios de parámetros hechos desde el panel.</p>
      <section className="tarjeta">
        {cambios?.length ? (
          <div className="tabla-desplazable">
            <table>
              <thead><tr><th>Fecha</th><th>Parámetro</th><th>Antes</th><th>Después</th><th>Quién</th></tr></thead>
              <tbody>
                {cambios.map((cambio) => {
                  const campo = CAMPOS.get(cambio.ruta);
                  return (
                    <tr key={cambio.id}>
                      <td>{fecha.format(new Date(cambio.creado_en))}</td>
                      <td>{campo?.etiqueta ?? cambio.ruta}</td>
                      <td>{formatearValor(campo, cambio.valor_anterior)}</td>
                      <td>{formatearValor(campo, cambio.valor_nuevo)}</td>
                      <td>{cambio.user_id === usuario.id ? 'Tú' : 'Otro usuario'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Aún no hay cambios.</p>
        )}
      </section>
    </>
  );
}
