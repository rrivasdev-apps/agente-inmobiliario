-- =============================================================================
-- Cobertura por barrio (reunión del 19 oct 2026).
--
-- * app.barrios_cobertura: copia de la hoja de Google "Barrios cobertura" que
--   edita el equipo. El flujo de n8n "Sincronizar barrios" la actualiza con
--   app.sincronizar_barrios(); un cambio en la hoja no exige desplegar.
-- * Complementa app.ciudades_cobertura (0009): la ciudad decide si el
--   inmueble está en el mercado; el barrio, si se atiende directamente.
-- =============================================================================

-- Misma normalización que src/cobertura/barrios.js, sin depender de unaccent.
create or replace function app.normalizar_texto(p text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'),
    '\s+', ' ', 'g'))
$$;

-- -----------------------------------------------------------------------------
-- Cobertura
-- -----------------------------------------------------------------------------

create table app.barrios_cobertura (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references app.tenants (id) on delete cascade,
  localidad           text not null,
  codigo_upz          integer not null check (codigo_upz > 0),
  upz                 text,
  barrio              text not null check (btrim(barrio) <> ''),
  nombre_normalizado  text not null,
  -- Variantes con que la gente nombra el barrio (p. ej. "Cedritos").
  alias               text[] not null default '{}',
  -- true = se atiende, false = se refiere a colegas, null = sin definir.
  atiende             boolean,
  notas               text,
  observacion_dato    text,
  -- Una fila que desaparece de la hoja se desactiva; no se borra.
  activo              boolean not null default true,
  creado_en           timestamptz not null default now(),
  actualizado_en      timestamptz not null default now(),
  unique (tenant_id, id),
  -- El mismo nombre puede existir en dos UPZ (Lisboa, Atenas…).
  unique (tenant_id, codigo_upz, nombre_normalizado)
);

create index barrios_cobertura_activos on app.barrios_cobertura (tenant_id) where activo;

create trigger barrios_cobertura_actualizado
  before update on app.barrios_cobertura
  for each row execute function app.tocar_actualizado();

/**
 * Sincroniza la cobertura de un tenant con las filas de la hoja, ya
 * preparadas por prepararSincronizacion() de src/cobertura/barrios.js.
 *
 * Aborta sin cambiar nada si llegan 0 filas o menos de la mitad de las
 * activas: protege contra una lectura incompleta de la hoja.
 */
create or replace function app.sincronizar_barrios(
  p_tenant_slug  text,
  p_filas        jsonb,
  p_advertencias jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
set search_path = app, pg_temp
set client_min_messages = warning
as $$
declare
  v_tenant      uuid;
  v_recibidas   integer;
  v_activas     integer;
  v_insertados  integer;
  v_actualizados integer;
  v_desactivados integer;
  v_resumen     jsonb;
begin
  select id into v_tenant from app.tenants where slug = p_tenant_slug;
  if v_tenant is null then
    raise exception 'Tenant desconocido: %', p_tenant_slug;
  end if;
  if jsonb_typeof(p_filas) is distinct from 'array' then
    raise exception 'p_filas debe ser un arreglo JSON';
  end if;

  drop table if exists _filas;
  create temp table _filas on commit drop as
  select distinct on (f.codigo_upz, app.normalizar_texto(f.barrio))
    btrim(f.localidad) as localidad,
    f.codigo_upz,
    nullif(btrim(f.upz), '') as upz,
    btrim(f.barrio) as barrio,
    app.normalizar_texto(f.barrio) as nombre_normalizado,
    coalesce(f.alias, '{}') as alias,
    f.atiende,
    nullif(btrim(f.notas), '') as notas,
    nullif(btrim(f.observacion_dato), '') as observacion_dato
  from rows from (jsonb_to_recordset(p_filas) as (
    localidad text, codigo_upz integer, upz text, barrio text, alias text[],
    atiende boolean, notas text, observacion_dato text)) with ordinality
    as f(localidad, codigo_upz, upz, barrio, alias, atiende, notas, observacion_dato, ordinality)
  where coalesce(btrim(f.barrio), '') <> ''
  order by f.codigo_upz, app.normalizar_texto(f.barrio), f.ordinality desc;

  select count(*) into v_recibidas from _filas;
  select count(*) into v_activas from app.barrios_cobertura where tenant_id = v_tenant and activo;

  if v_recibidas = 0 or v_recibidas < v_activas / 2.0 then
    raise exception 'Sincronización cancelada: la hoja trae % filas y hay % barrios activos. Revise la hoja antes de reintentar.',
      v_recibidas, v_activas;
  end if;

  with cambios as (
    insert into app.barrios_cobertura as b
      (tenant_id, localidad, codigo_upz, upz, barrio, nombre_normalizado, alias, atiende, notas, observacion_dato)
    select v_tenant, localidad, codigo_upz, upz, barrio, nombre_normalizado, alias, atiende, notas, observacion_dato
    from _filas
    on conflict (tenant_id, codigo_upz, nombre_normalizado) do update set
      localidad = excluded.localidad,
      upz = excluded.upz,
      barrio = excluded.barrio,
      alias = excluded.alias,
      atiende = excluded.atiende,
      notas = excluded.notas,
      observacion_dato = excluded.observacion_dato,
      activo = true
    -- Solo se tocan las filas que cambiaron, para que el resumen sea útil.
    where (b.localidad, b.upz, b.barrio, b.alias, b.atiende, b.notas, b.observacion_dato, b.activo)
      is distinct from
          (excluded.localidad, excluded.upz, excluded.barrio, excluded.alias, excluded.atiende,
           excluded.notas, excluded.observacion_dato, true)
    returning (xmax = 0) as insertado
  )
  select count(*) filter (where insertado), count(*) filter (where not insertado)
    into v_insertados, v_actualizados
  from cambios;

  update app.barrios_cobertura b set activo = false
  where b.tenant_id = v_tenant and b.activo
    and not exists (
      select 1 from _filas f
      where f.codigo_upz = b.codigo_upz and f.nombre_normalizado = b.nombre_normalizado
    );
  get diagnostics v_desactivados = row_count;

  v_resumen := jsonb_build_object(
    'recibidas', v_recibidas,
    'insertados', v_insertados,
    'actualizados', v_actualizados,
    'desactivados', v_desactivados,
    'atendidos', (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and activo and atiende),
    'no_atendidos', (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and activo and atiende = false),
    'sin_definir', (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and activo and atiende is null),
    'advertencias', coalesce(p_advertencias, '[]'::jsonb)
  );

  insert into app.eventos (tenant_id, nivel, operacion, entidad, mensaje, contexto)
  values (
    v_tenant,
    case when jsonb_array_length(coalesce(p_advertencias, '[]'::jsonb)) > 0 then 'advertencia' else 'info' end::app.nivel_evento,
    'sincronizar_barrios',
    'barrios_cobertura',
    format('Cobertura sincronizada: %s nuevos, %s actualizados, %s desactivados',
           v_insertados, v_actualizados, v_desactivados),
    v_resumen
  );

  return v_resumen;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS (mismo patrón que 0009)
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['barrios_cobertura'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format(
      'create policy %I on app.%I for select to authenticated
         using (tenant_id in (select app.tenants_del_usuario()))',
      t || '_lectura_miembros', t
    );
    execute format(
      'create policy %I on app.%I for all to authenticated
         using (app.es_admin_de(tenant_id))
         with check (app.es_admin_de(tenant_id))',
      t || '_escritura_admin', t
    );
  end loop;
end;
$$;

grant select, insert, update, delete on app.barrios_cobertura to authenticated, service_role;
grant execute on function app.normalizar_texto(text) to authenticated, service_role;
grant execute on function app.sincronizar_barrios(text, jsonb, jsonb) to authenticated, service_role;
