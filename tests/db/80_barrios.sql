-- Cobertura por barrio (reunión del 19 oct 2026).
-- Usa el tenant B y los usuarios creados en 10_reglas.sql.
\set ON_ERROR_STOP on

create or replace function pg_temp.debe_fallar(p_sql text, p_patron text)
returns void language plpgsql as $$
declare
  v_fallo boolean := false;
begin
  begin
    execute p_sql;
  exception when others then
    v_fallo := true;
    if sqlerrm not like '%' || p_patron || '%' then
      raise exception 'Error inesperado para "%": %', p_sql, sqlerrm;
    end if;
  end;
  if not v_fallo then
    raise exception 'Se esperaba un error que contenga "%" para: %', p_patron, p_sql;
  end if;
end;
$$;

create or replace function pg_temp.filas_actuales(p_slug text)
returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object(
    'localidad', localidad, 'codigo_upz', codigo_upz, 'upz', upz, 'barrio', barrio,
    'alias', alias, 'atiende', atiende, 'notas', notas, 'observacion_dato', observacion_dato))
  from app.barrios_cobertura b join app.tenants t on t.id = b.tenant_id
  where t.slug = p_slug and b.activo
$$;

-- El seed carga la hoja de hoy: 447 barrios, 114 Sí, 333 No --------------------
do $$
declare
  v_tenant uuid := (select id from app.tenants where slug = 'javier-nunez');
begin
  if (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and activo) <> 447
     or (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and atiende) <> 114
     or (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and atiende = false) <> 333 then
    raise exception 'El seed no cargó la cobertura esperada (447 / 114 Sí / 333 No)';
  end if;
  if (select count(*) from app.barrios_cobertura where tenant_id = v_tenant and barrio = 'La Cabrera') <> 2 then
    raise exception 'Un barrio en dos UPZ debe quedar como dos filas';
  end if;
  if not exists (select 1 from app.eventos where tenant_id = v_tenant and operacion = 'sincronizar_barrios' and nivel = 'advertencia') then
    raise exception 'La sincronización con advertencias debe dejar un evento de advertencia';
  end if;
end $$;

-- Sincronizar refleja los cambios de la hoja ----------------------------------
do $$
declare
  v_filas jsonb := pg_temp.filas_actuales('javier-nunez');
  v_r jsonb;
begin
  -- Cambia Canaima a Sí, quita Torca 1 y agrega un barrio nuevo.
  select jsonb_agg(
           case when f->>'barrio' = 'Canaima' then jsonb_set(f, '{atiende}', 'true') else f end)
    into v_filas
  from jsonb_array_elements(v_filas) f
  where f->>'barrio' <> 'Torca 1';
  v_filas := v_filas || jsonb_build_array(jsonb_build_object(
    'localidad', 'Barrios Unidos', 'codigo_upz', 21, 'upz', 'Los Andes', 'barrio', 'Rionegro',
    'alias', jsonb_build_array('Río Negro'), 'atiende', true));

  v_r := app.sincronizar_barrios('javier-nunez', v_filas);
  if (v_r->>'insertados')::int <> 1 or (v_r->>'actualizados')::int <> 1 or (v_r->>'desactivados')::int <> 1 then
    raise exception 'Resumen inesperado: %', v_r;
  end if;
  if (select atiende from app.barrios_cobertura where barrio = 'Canaima') is not true then
    raise exception 'Canaima debió pasar a Sí';
  end if;
  if (select activo from app.barrios_cobertura where barrio = 'Torca 1') then
    raise exception 'Torca 1 debió desactivarse, no borrarse';
  end if;
  if (select alias from app.barrios_cobertura where barrio = 'Rionegro') <> array['Río Negro'] then
    raise exception 'Los alias deben guardarse como arreglo';
  end if;

  -- Volver a sincronizar lo mismo no cambia nada.
  v_r := app.sincronizar_barrios('javier-nunez', v_filas);
  if (v_r->>'insertados')::int + (v_r->>'actualizados')::int + (v_r->>'desactivados')::int <> 0 then
    raise exception 'Una sincronización sin cambios no debe tocar filas: %', v_r;
  end if;
end $$;

-- Protección contra una hoja vacía o incompleta
select pg_temp.debe_fallar($q$select app.sincronizar_barrios('javier-nunez', '[]'::jsonb)$q$, 'Sincronización cancelada');
select pg_temp.debe_fallar(
  $q$select app.sincronizar_barrios('javier-nunez',
       (select jsonb_agg(f) from (select f from jsonb_array_elements(pg_temp.filas_actuales('javier-nunez')) f limit 100) x))$q$,
  'Sincronización cancelada');
select pg_temp.debe_fallar($q$select app.sincronizar_barrios('no-existe', '[]'::jsonb)$q$, 'Tenant desconocido');

do $$ begin raise notice 'OK sincronización de cobertura'; end $$;

-- RLS: el tenant B no ve la cobertura del tenant A -------------
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
begin
  if exists (select 1 from app.barrios_cobertura) then
    raise exception 'RLS: el tenant B ve la cobertura del tenant A';
  end if;
end $$;

select pg_temp.debe_fallar(
  $q$select app.sincronizar_barrios('javier-nunez', '[{"localidad":"X","codigo_upz":1,"barrio":"Y"}]'::jsonb)$q$,
  'Tenant desconocido');

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
begin
  if (select count(*) from app.barrios_cobertura where activo) <> 447 then
    raise exception 'RLS: el admin del tenant A debería ver sus 447 barrios activos';
  end if;
  raise notice 'OK aislamiento de cobertura';
end $$;
reset role;
