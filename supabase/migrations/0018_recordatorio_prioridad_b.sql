-- =============================================================================
-- Prioridad B con recordatorio y barrios no listados en el reporte (4 nov 2026).
--
-- * Prioridad B (plazo mayor a prioridad.alta_hasta_meses) ya no se agenda:
--   queda en nutricion. Un flujo diario de n8n le envía por correo a Javier los
--   contactos cuya fecha estimada de venta está a prioridad.recordatorio_meses_antes
--   meses (reunión del 27 oct 2026). La fecha se calcula desde que el contacto
--   entró a nutricion más su plazo en meses; cada recordatorio enviado queda en
--   app.eventos (operacion recordatorio_prioridad_b) para no repetirlo.
-- * El reporte semanal suma los barrios que no se pudieron resolver con
--   app.barrios_cobertura (eventos cobertura_barrio), para revisarlos en la hoja.
-- =============================================================================

-- Destinatarios de los correos internos del tenant: usuarios activos que reciben
-- el reporte, más parametros.reporte_no_calificados.destinatarios.
create or replace function app.destinatarios_reporte(p_tenant uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(distinct d), '[]'::jsonb) from (
    select u.email as d from app.usuarios u
    where u.tenant_id = p_tenant and u.activo and u.recibe_reporte
    union
    select jsonb_array_elements_text(coalesce(t.parametros->'reporte_no_calificados'->'destinatarios', '[]'::jsonb))
    from app.tenants t where t.id = p_tenant
  ) x;
$$;

-- Contactos de prioridad B cuyo recordatorio vence hoy o antes y no se ha enviado.
create or replace function app.recordatorios_prioridad_b()
returns setof jsonb
language sql
stable
as $$
  with config as (
    select t.id, t.nombre, t.zona_horaria,
           (t.parametros->'prioridad'->>'recordatorio_meses_antes')::int as meses_antes
    from app.tenants t
    where t.activo and t.parametros->'prioridad'->>'recordatorio_meses_antes' is not null
  ),
  candidatos as (
    select cf.id as tenant_id, c.id as contacto_id, c.datos, c.nombre, c.telefono, c.canal_origen,
           e.creado_en as en_nutricion_desde,
           -- Un plazo ilegible cuenta como 0: el recordatorio sale de inmediato para revisarlo a mano.
           case when c.datos->>'plazo_meses' ~ '^\d+(\.\d+)?$' then round((c.datos->>'plazo_meses')::numeric)::int else 0 end as plazo,
           cf.meses_antes
    from config cf
    join app.contactos c on c.tenant_id = cf.id and c.estado = 'nutricion' and c.rol_origen = 'lucia'
    join lateral (
      select h.creado_en from app.historial_estados h
      where h.tenant_id = cf.id and h.contacto_id = c.id and h.hacia = 'nutricion'
      order by h.creado_en desc limit 1
    ) e on true
  ),
  vencidos as (
    select k.*, k.en_nutricion_desde + make_interval(months => k.plazo) as fecha_estimada,
           k.en_nutricion_desde + make_interval(months => greatest(k.plazo - k.meses_antes, 0)) as fecha_recordatorio
    from candidatos k
  )
  select jsonb_build_object(
    'tenant', jsonb_build_object('id', cf.id, 'nombre', cf.nombre, 'zona_horaria', cf.zona_horaria),
    'destinatarios', app.destinatarios_reporte(cf.id),
    'contactos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'contacto_id', v.contacto_id,
               'nombre', coalesce(v.datos->>'nombre', v.nombre),
               'telefono', coalesce(v.telefono, v.datos->>'telefono'),
               'canal', v.canal_origen,
               'barrio', v.datos->>'barrio',
               'tipo_inmueble', v.datos->>'tipo_inmueble',
               'valor_estimado_cop', v.datos->>'valor_estimado_cop',
               'plazo_meses', v.plazo,
               'en_nutricion_desde', v.en_nutricion_desde,
               'fecha_estimada', v.fecha_estimada) order by v.fecha_estimada)
      from vencidos v
      where v.tenant_id = cf.id
        and v.fecha_recordatorio <= now()
        and not exists (
          select 1 from app.eventos ev
          where ev.tenant_id = cf.id and ev.operacion = 'recordatorio_prioridad_b'
            and ev.entidad = 'contacto' and ev.entidad_id = v.contacto_id
            and ev.creado_en >= v.en_nutricion_desde)
    ), '[]'::jsonb))
  from config cf;
$$;

-- Deja constancia de los recordatorios enviados (uno por contacto y paso por nutricion).
create or replace function app.marcar_recordatorios_prioridad_b(p_tenant uuid, p_contactos jsonb)
returns int
language sql
as $$
  with ins as (
    insert into app.eventos (tenant_id, nivel, operacion, entidad, entidad_id, mensaje)
    select p_tenant, 'info', 'recordatorio_prioridad_b', 'contacto', c.id, 'Recordatorio de prioridad B enviado por correo'
    from app.contactos c
    where c.tenant_id = p_tenant
      and c.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(p_contactos) = 'array' then p_contactos else '[]'::jsonb end))
    returning 1
  )
  select count(*)::int from ins;
$$;

-- Reporte semanal (0005) con la sección de barrios no resueltos del periodo.
alter function app.reporte_no_calificados(uuid, timestamptz) rename to reporte_no_calificados_base;

create or replace function app.reporte_no_calificados(p_tenant uuid, p_desde timestamptz)
returns jsonb
language sql
stable
as $$
  select app.reporte_no_calificados_base(p_tenant, p_desde) || jsonb_build_object('barrios_no_listados', coalesce((
    select jsonb_agg(fila order by fila->>'fecha') from (
      select distinct on (c.id) jsonb_build_object(
               'fecha', ev.creado_en,
               'nombre', coalesce(c.datos->>'nombre', c.nombre),
               'telefono', coalesce(c.telefono, c.datos->>'telefono'),
               'canal', c.canal_origen,
               'rol', c.rol_origen,
               'barrio', c.datos->>'barrio',
               'direccion', c.datos->>'direccion',
               'detalle', ev.mensaje,
               'estado_actual', c.estado) as fila
      from app.eventos ev
      join app.conversaciones cv on cv.tenant_id = p_tenant and cv.id = ev.entidad_id
      join app.contactos c on c.tenant_id = p_tenant and c.id = cv.contacto_id
      where ev.tenant_id = p_tenant and ev.operacion = 'cobertura_barrio'
        and ev.entidad = 'conversacion' and ev.creado_en >= p_desde
      order by c.id, ev.creado_en desc
    ) x), '[]'::jsonb));
$$;

-- El reporte por tenant usa la misma función de destinatarios.
create or replace function app.reportes_no_calificados()
returns setof jsonb
language sql
stable
as $$
  select app.reporte_no_calificados(t.id, now() - make_interval(days => coalesce((t.parametros->'reporte_no_calificados'->>'dias')::int, 7)))
         || jsonb_build_object('destinatarios', app.destinatarios_reporte(t.id))
  from app.tenants t
  where t.activo and coalesce((t.parametros->'reporte_no_calificados'->>'activo')::boolean, false);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.destinatarios_reporte(uuid)',
    'app.recordatorios_prioridad_b()',
    'app.marcar_recordatorios_prioridad_b(uuid, jsonb)',
    'app.reporte_no_calificados_base(uuid, timestamptz)',
    'app.reporte_no_calificados(uuid, timestamptz)',
    'app.reportes_no_calificados()'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
