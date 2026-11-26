import Link from 'next/link';
import { cargarTenant, normalizarTexto } from '@/lib/tenant';
import { agregarCiudad, cambiarCiudad } from './actions';

const AVISOS: Record<string, { tipo: 'ok' | 'mal'; texto: string }> = {
  ciudad_agregada: { tipo: 'ok', texto: 'Ciudad agregada. El agente la atiende desde el próximo mensaje.' },
  ciudad_activada: { tipo: 'ok', texto: 'Ciudad activada.' },
  ciudad_desactivada: { tipo: 'ok', texto: 'Ciudad desactivada: el agente ya no la atiende directamente.' },
  ciudad_invalida: { tipo: 'mal', texto: 'Escribe el nombre de la ciudad.' },
  error: { tipo: 'mal', texto: 'No se pudo guardar el cambio.' },
};

const FILTROS = [
  { valor: '', titulo: 'Todos' },
  { valor: 'si', titulo: 'Se atienden' },
  { valor: 'no', titulo: 'Se refieren' },
  { valor: 'sin', titulo: 'Sin definir' },
];

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

  const { data: ciudades } = await supabase
    .from('ciudades_cobertura').select('id, ciudad, activa').eq('tenant_id', tenant.id).order('ciudad');

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
  const { data: barrios, count } = await consulta.returns<Barrio[]>();

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
          Se editan en la hoja de Google de barrios del equipo (columna «¿Lo atiendo?»); el agente la sincroniza cada 15 minutos.
          Aquí se consultan.
        </p>
        <form className="fila-form" style={{ marginBottom: 12 }}>
          <input type="text" name="q" defaultValue={q} aria-label="Buscar barrio" placeholder="Buscar barrio" />
          <select name="atiende" defaultValue={atiende} aria-label="Filtrar" style={{ width: 'auto' }}>
            {FILTROS.map((filtro) => <option key={filtro.valor} value={filtro.valor}>{filtro.titulo}</option>)}
          </select>
          <button type="submit">Buscar</button>
          {(q || atiende) && <Link href={`/t/${slug}/cobertura`}>Limpiar</Link>}
        </form>
        <p style={{ color: 'var(--suave)', fontSize: 13 }}>
          {count ?? 0} barrios{(count ?? 0) > 200 ? ' (se muestran los primeros 200; usa la búsqueda)' : ''}
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
