import Link from 'next/link';
import { cargarTenant, normalizarTexto } from '@/lib/tenant';
import { agregarCiudad, cambiarCiudad, sincronizarBarrios } from './actions';

const AVISOS: Record<string, { tipo: 'ok' | 'mal'; texto: string }> = {
  ciudad_agregada: { tipo: 'ok', texto: 'Ciudad agregada. El agente la atiende desde el próximo mensaje.' },
  ciudad_activada: { tipo: 'ok', texto: 'Ciudad activada.' },
  ciudad_desactivada: { tipo: 'ok', texto: 'Ciudad desactivada: el agente ya no la atiende directamente.' },
  ciudad_invalida: { tipo: 'mal', texto: 'Escribe el nombre de la ciudad.' },
  sincronizacion_pedida: { tipo: 'ok', texto: 'Sincronización pedida. En un minuto recarga la página para ver los barrios actualizados.' },
  sincronizacion_reciente: { tipo: 'mal', texto: 'Ya se pidió una sincronización hace menos de 2 minutos. Espera un momento y recarga la página.' },
  sincronizacion_sin_configurar: { tipo: 'mal', texto: 'La sincronización a pedido no está configurada todavía.' },
  error: { tipo: 'mal', texto: 'No se pudo guardar el cambio.' },
};

const FILTROS = [
  { valor: '', titulo: 'Todos' },
  { valor: 'si', titulo: 'Se atienden' },
  { valor: 'no', titulo: 'Se refieren' },
  { valor: 'sin', titulo: 'Sin definir' },
];

interface EstadoSincronizacion {
  ultima: { fecha: string; mensaje: string } | null;
  pedida: string | null;
}

interface Barrio {
  id: string; localidad: string; upz: string | null; barrio: string; atiende: boolean | null; notas: string | null;
}

export default async function PaginaCobertura({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ q?: string; atiende?: string; aviso?: string }>;
}) {
  const { slug } = await params;
  const { q = '', atiende = '', aviso } = await searchParams;
  const { supabase, tenant, esAdmin } = await cargarTenant(slug);

  const { data: ciudades, error: errorCiudades } = await supabase
    .from('ciudades_cobertura').select('id, ciudad, activa').eq('tenant_id', tenant.id).order('ciudad');
  if (errorCiudades) throw new Error(`No se pudieron leer las ciudades: ${errorCiudades.message}`);

  let consulta = supabase
    .from('barrios_cobertura')
    .select('id, localidad, upz, barrio, atiende, notas', { count: 'exact' })
    .eq('tenant_id', tenant.id).eq('activo', true)
    .order('localidad').order('barrio')
    .limit(200);
  const busqueda = normalizarTexto(q);
  // Los comodines de LIKE en la búsqueda se escapan para que se busquen literalmente.
  if (busqueda) consulta = consulta.ilike('nombre_normalizado', `%${busqueda.replace(/[%_\\]/g, '\\$&')}%`);
  if (atiende === 'si') consulta = consulta.eq('atiende', true);
  if (atiende === 'no') consulta = consulta.eq('atiende', false);
  if (atiende === 'sin') consulta = consulta.is('atiende', null);
  const { data: barrios, count, error: errorBarrios } = await consulta.returns<Barrio[]>();
  if (errorBarrios) throw new Error(`No se pudieron leer los barrios: ${errorBarrios.message}`);

  const { data: datosEstado } = await supabase.rpc('estado_sincronizacion_barrios', { p_tenant: tenant.id });
  const estado = datosEstado as EstadoSincronizacion | null;
  const fechaHora = new Intl.DateTimeFormat('es-CO', { timeZone: tenant.zona_horaria, dateStyle: 'medium', timeStyle: 'short' });

  const mensaje = aviso ? AVISOS[aviso] : undefined;

  return (
    <>
      <h1>Cobertura</h1>
      <p className="subtitulo">Dónde atiende el agente directamente. Fuera de esto, ofrece una referencia a un colega.</p>
      {mensaje && <p className={`aviso ${mensaje.tipo}`} role="status" style={{ marginBottom: 20 }}>{mensaje.texto}</p>}

      <section className="tarjeta">
        <h2>Ciudades atendidas</h2>
        <p>Desactivar una ciudad no la borra: se puede volver a activar.</p>
        <table>
          <thead><tr><th>Ciudad</th><th>Estado</th>{esAdmin && <th />}</tr></thead>
          <tbody>
            {ciudades?.map((fila) => (
              <tr key={fila.id}>
                <td>{fila.ciudad}</td>
                <td><span className={`etiqueta ${fila.activa ? 'si' : ''}`}>{fila.activa ? 'Activa' : 'Inactiva'}</span></td>
                {esAdmin && (
                  <td>
                    <form action={cambiarCiudad.bind(null, slug, fila.id, !fila.activa)}>
                      <button type="submit">{fila.activa ? 'Desactivar' : 'Activar'}</button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {esAdmin && (
          <form action={agregarCiudad.bind(null, slug)} className="fila-form" style={{ marginTop: 16 }}>
            <input type="text" name="ciudad" aria-label="Nueva ciudad" placeholder="Nueva ciudad, p. ej. Chía" required />
            <button type="submit">Agregar ciudad</button>
          </form>
        )}
      </section>

      <section className="tarjeta">
        <h2>Barrios</h2>
        <p>
          Se editan en la hoja de Google de barrios del equipo (columna «¿Lo atiendo?»); el agente la sincroniza una vez al día,
          a las 6:00 a. m. Aquí se consultan.
        </p>
        <div className="fila-form" style={{ marginBottom: 12, alignItems: 'center' }}>
          <p style={{ margin: 0, color: 'var(--suave)', fontSize: 13 }}>
            {estado?.ultima
              ? `Última sincronización: ${fechaHora.format(new Date(estado.ultima.fecha))}. ${estado.ultima.mensaje}.`
              : 'Aún no hay sincronizaciones registradas.'}
          </p>
          {esAdmin && (
            <form action={sincronizarBarrios.bind(null, slug)}>
              <button type="submit">Sincronizar ahora</button>
            </form>
          )}
        </div>
        <form className="fila-form" style={{ marginBottom: 12 }}>
          <input type="text" name="q" defaultValue={q} aria-label="Buscar barrio" placeholder="Buscar barrio" />
          <select name="atiende" defaultValue={atiende} aria-label="Filtrar" style={{ width: 'auto' }}>
            {FILTROS.map((filtro) => <option key={filtro.valor} value={filtro.valor}>{filtro.titulo}</option>)}
          </select>
          <button type="submit">Buscar</button>
          {(q || atiende) && <Link href={`/t/${slug}/cobertura`}>Limpiar</Link>}
        </form>
        <p style={{ color: 'var(--suave)', fontSize: 13 }}>
          {count ?? 0} {count === 1 ? 'barrio' : 'barrios'}{(count ?? 0) > 200 ? ' (se muestran los primeros 200; usa la búsqueda)' : ''}
        </p>
        <div className="tabla-desplazable">
          <table>
            <thead><tr><th>Barrio</th><th>Localidad</th><th>UPZ</th><th>¿Se atiende?</th><th>Notas</th></tr></thead>
            <tbody>
              {barrios?.map((fila) => (
                <tr key={fila.id}>
                  <td>{fila.barrio}</td>
                  <td>{fila.localidad}</td>
                  <td>{fila.upz ?? ''}</td>
                  <td>
                    <span className={`etiqueta ${fila.atiende === true ? 'si' : fila.atiende === false ? 'no' : ''}`}>
                      {fila.atiende === true ? 'Sí' : fila.atiende === false ? 'No' : 'Sin definir'}
                    </span>
                  </td>
                  <td>{fila.notas ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
