begin;
-- =============================================================================
-- Panel de configuración (26 nov 2026).
--
-- Desde ahora los parámetros del tenant los administra la persona autorizada en
-- el panel web, y Supabase es la fuente de verdad: el seed ya no los reemplaza,
-- solo agrega las claves nuevas que aparezcan en tenant.json (app.fusionar_jsonb).
--
-- El panel no actualiza app.tenants directamente (RLS solo deja leerla): cambia
-- valores con app.actualizar_parametros, que exige ser admin del tenant, solo
-- acepta claves que ya existen y deja cada cambio en app.cambios_configuracion.
-- =============================================================================

-- Fusión profunda: p_encima gana; los objetos se fusionan clave por clave.
create or replace function app.fusionar_jsonb(p_base jsonb, p_encima jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_base) = 'object' and jsonb_typeof(p_encima) = 'object' then (
      select coalesce(jsonb_object_agg(
        k,
        case
          when p_base ? k and p_encima ? k then app.fusionar_jsonb(p_base -> k, p_encima -> k)
          when p_encima ? k then p_encima -> k
          else p_base -> k
        end), '{}'::jsonb)
      from (select jsonb_object_keys(p_base) as k union select jsonb_object_keys(p_encima)) claves)
    when p_encima is null then p_base
    else p_encima
  end;
$$;

create table app.cambios_configuracion (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references app.tenants (id) on delete cascade,
  user_id         uuid,                -- auth.users.id de quien hizo el cambio
  ruta            text not null,       -- p. ej. 'propietarios.valor_minimo_cop'
  valor_anterior  jsonb,
  valor_nuevo     jsonb,
  creado_en       timestamptz not null default now()
);

create index cambios_configuracion_recientes on app.cambios_configuracion (tenant_id, creado_en desc);

-- Solo lectura para miembros: las filas las escribe app.actualizar_parametros.
alter table app.cambios_configuracion enable row level security;
create policy cambios_configuracion_lectura_miembros on app.cambios_configuracion
  for select to authenticated
  using (tenant_id in (select app.tenants_del_usuario()));
grant select on app.cambios_configuracion to authenticated;
grant select, insert, update, delete on app.cambios_configuracion to service_role;

/**
 * Cambia parámetros del tenant. p_cambios = { "ruta.con.puntos": valor, ... }.
 *
 * - Solo admins del tenant (app.es_admin_de).
 * - La ruta debe existir: el panel no puede inventar parámetros que el agente no lee.
 * - Un valor no nulo debe tener el mismo tipo JSON que el actual (si el actual no es nulo),
 *   para que un error del panel no deje, por ejemplo, un texto donde el evaluador espera un número.
 * - Los valores iguales al actual no se registran.
 * Devuelve los parámetros resultantes.
 */
create or replace function app.actualizar_parametros(p_tenant uuid, p_cambios jsonb)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_parametros jsonb;
  v_ruta text;
  v_camino text[];
  v_nuevo jsonb;
  v_anterior jsonb;
begin
  if not app.es_admin_de(p_tenant) then
    raise exception 'No autorizado para configurar este tenant' using errcode = '42501';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' then
    raise exception 'p_cambios debe ser un objeto { ruta: valor }' using errcode = '22023';
  end if;

  select parametros into v_parametros from app.tenants where id = p_tenant for update;
  if not found then
    raise exception 'Tenant inexistente' using errcode = 'P0002';
  end if;

  for v_ruta, v_nuevo in select key, value from jsonb_each(p_cambios) loop
    v_camino := string_to_array(v_ruta, '.');
    -- #> devuelve SQL NULL si la ruta no existe y 'null'::jsonb si existe con valor nulo.
    v_anterior := v_parametros #> v_camino;
    if v_anterior is null then
      raise exception 'Parámetro desconocido: %', v_ruta using errcode = '22023';
    end if;
    if jsonb_typeof(v_anterior) <> 'null' and jsonb_typeof(v_nuevo) <> 'null'
       and jsonb_typeof(v_anterior) <> jsonb_typeof(v_nuevo) then
      raise exception 'Tipo inválido para %: se esperaba %', v_ruta, jsonb_typeof(v_anterior)
        using errcode = '22023';
    end if;
    if v_anterior is distinct from v_nuevo then
      v_parametros := jsonb_set(v_parametros, v_camino, v_nuevo, false);
      insert into app.cambios_configuracion (tenant_id, user_id, ruta, valor_anterior, valor_nuevo)
      values (p_tenant, auth.uid(), v_ruta, v_anterior, v_nuevo);
    end if;
  end loop;

  update app.tenants set parametros = v_parametros where id = p_tenant;
  return v_parametros;
end;
$$;

revoke execute on function app.actualizar_parametros(uuid, jsonb) from public;
grant execute on function app.actualizar_parametros(uuid, jsonb) to authenticated, service_role;
grant execute on function app.fusionar_jsonb(jsonb, jsonb) to authenticated, service_role;

commit;
