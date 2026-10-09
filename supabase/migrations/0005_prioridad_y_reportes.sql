-- =============================================================================
-- Calificación mixta y parámetros por tenant.
--
-- * app.tenants.parametros: valores configurables (cobertura, umbral de
--   prioridad, mínimos de compra y arriendo, dossier, reporte). El evaluador
--   los lee a través del contexto.
-- * Quien cumple los criterios queda con prioridad alta (se agenda) o baja
--   (estado nutricion, no se agenda).
-- * app.reportes_no_calificados(): datos del reporte semanal de leads no
--   calificados y de prioridad baja, con su motivo.
-- =============================================================================

alter table app.tenants
  add column parametros jsonb not null default '{}'::jsonb
  check (jsonb_typeof(parametros) = 'object');

alter table app.evaluaciones_calificacion
  add column prioridad text check (prioridad in ('alta', 'baja'));

insert into app.transiciones_estado (desde, hacia) values
  ('en_calificacion',        'nutricion'),
  ('informacion_incompleta', 'nutricion'),
  ('nutricion',              'calificado_pendiente_agendamiento'),  -- ahora es urgente
  ('nutricion',              'no_calificado'),
  ('nutricion',              'archivado')
on conflict do nothing;

-- El contexto incluye los parámetros del tenant.
create or replace function app.contexto_conversacion(p_tenant uuid, p_conversacion uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_ctx      jsonb := app.contexto_base(p_tenant, p_conversacion);
  v_conv     app.conversaciones;
  v_contacto app.contactos;
  v_rol      app.roles_agente;
begin
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  select * into v_contacto from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;
  select * into v_rol from app.roles_agente where tenant_id = p_tenant and codigo = v_conv.rol_codigo;

  v_ctx := jsonb_set(v_ctx, '{contacto}', v_ctx->'contacto' || jsonb_build_object(
    'ghl_contact_id', v_contacto.ghl_contact_id,
    'email', v_contacto.email,
    'canal_origen', v_contacto.canal_origen));
  v_ctx := jsonb_set(v_ctx, '{conversacion}', v_ctx->'conversacion' || jsonb_build_object('agenda', v_conv.agenda));
  v_ctx := jsonb_set(v_ctx, '{tenant}', v_ctx->'tenant' || jsonb_build_object(
    'parametros', (select parametros from app.tenants where id = p_tenant)));
  if v_ctx->'rol' <> 'null'::jsonb then
    v_ctx := jsonb_set(v_ctx, '{rol}', v_ctx->'rol' || jsonb_build_object('etiqueta_crm', v_rol.etiqueta_crm));
  end if;

  return v_ctx || jsonb_build_object('cita', (
    select jsonb_build_object('id', id, 'inicio', inicio, 'zona_horaria', zona_horaria,
                              'modalidad', modalidad, 'estado', estado)
    from app.citas
    where tenant_id = p_tenant and contacto_id = v_conv.contacto_id
      and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
    order by creado_en desc
    limit 1));
end;
$$;

-- La prioridad decide entre agendar (alta) y nutrir (baja). Un contacto en
-- nutrición que vuelve con urgencia pasa a pendiente de agendar.
create or replace function app.guardar_evaluacion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_eval     jsonb := p->'evaluacion';
  v_conv     app.conversaciones;
  v_anterior app.estado_contacto;
  v_destino  app.estado_contacto;
  v_motivo   text;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');

  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  select estado into v_anterior from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;

  insert into app.evaluaciones_calificacion (
    tenant_id, conversacion_id, contacto_id, rol_codigo, resultado, campos_faltantes, criterios, motivo, prioridad)
  values (
    p_tenant, p_conversacion, v_conv.contacto_id, v_conv.rol_codigo,
    (v_eval->>'resultado')::app.resultado_calificacion,
    coalesce((select array_agg(x) from jsonb_array_elements_text(v_eval->'campos_faltantes') x), '{}'),
    jsonb_build_object('accion', v_eval->'accion', 'codigo_motivo', v_eval->'codigo_motivo', 'reglas', coalesce(v_eval->'reglas', '[]'::jsonb)),
    v_eval->>'motivo', v_eval->>'prioridad');

  v_destino := case v_eval->>'resultado'
    when 'calificado' then
      case when v_eval->>'prioridad' = 'baja' then 'nutricion' else 'calificado_pendiente_agendamiento' end
    when 'no_calificado' then 'no_calificado'
    else 'informacion_incompleta'
  end;
  v_motivo := case when v_destino = 'no_calificado' then coalesce(v_eval->>'codigo_motivo', v_eval->>'motivo') end;

  -- La evaluación solo mueve el estado durante la calificación; después, el
  -- agendamiento (registrar_oferta, registrar_cita) es dueño del estado.
  if v_anterior in ('en_calificacion', 'informacion_incompleta', 'nutricion')
     and v_destino <> v_anterior and exists (
    select 1 from app.transiciones_estado where desde = v_anterior and hacia = v_destino
  ) then
    update app.contactos set estado = v_destino, motivo_estado = v_motivo
    where tenant_id = p_tenant and id = v_conv.contacto_id;
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', v_eval, 'estado_anterior', v_anterior);
end;
$$;

-- -----------------------------------------------------------------------------
-- Reporte de leads no calificados y de prioridad baja
-- -----------------------------------------------------------------------------

create or replace function app.reporte_no_calificados(p_tenant uuid, p_desde timestamptz)
returns jsonb
language sql
stable
as $$
  with movimientos as (
    -- Contactos que entraron a no_calificado o nutricion en el periodo.
    select distinct on (h.contacto_id) h.contacto_id, h.hacia, h.creado_en
    from app.historial_estados h
    where h.tenant_id = p_tenant and h.creado_en >= p_desde
      and h.hacia in ('no_calificado', 'nutricion')
    order by h.contacto_id, h.creado_en desc
  ),
  filas as (
    select m.hacia as categoria,
           jsonb_build_object(
             'fecha', m.creado_en,
             'nombre', coalesce(c.datos->>'nombre', c.nombre),
             'telefono', coalesce(c.telefono, c.datos->>'telefono'),
             'canal', c.canal_origen,
             'rol', c.rol_origen,
             'operacion', c.datos->>'operacion',
             'estado_actual', c.estado,
             'motivo', coalesce(e.motivo, c.motivo_estado),
             'plazo_meses', coalesce(c.datos->>'plazo_meses', c.datos->>'horizonte_compra_meses')
           ) as fila
    from movimientos m
    join app.contactos c on c.tenant_id = p_tenant and c.id = m.contacto_id
    left join lateral (
      select motivo from app.evaluaciones_calificacion ev
      where ev.tenant_id = p_tenant and ev.contacto_id = c.id
      order by ev.creado_en desc, ev.id desc
      limit 1
    ) e on true
  )
  select jsonb_build_object(
    'tenant', (select jsonb_build_object('id', id, 'nombre', nombre, 'zona_horaria', zona_horaria) from app.tenants where id = p_tenant),
    'desde', p_desde,
    'hasta', now(),
    'no_calificados', coalesce((select jsonb_agg(fila order by fila->>'fecha') from filas where categoria = 'no_calificado'), '[]'::jsonb),
    'prioridad_baja', coalesce((select jsonb_agg(fila order by fila->>'fecha') from filas where categoria = 'nutricion'), '[]'::jsonb)
  );
$$;

-- Un reporte por tenant activo con el reporte habilitado en sus parámetros.
create or replace function app.reportes_no_calificados()
returns setof jsonb
language sql
stable
as $$
  select app.reporte_no_calificados(t.id, now() - make_interval(days => coalesce((t.parametros->'reporte_no_calificados'->>'dias')::int, 7)))
         || jsonb_build_object('destinatarios', coalesce(t.parametros->'reporte_no_calificados'->'destinatarios', '[]'::jsonb))
  from app.tenants t
  where t.activo and coalesce((t.parametros->'reporte_no_calificados'->>'activo')::boolean, false);
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.contexto_conversacion(uuid, uuid)',
    'app.guardar_evaluacion(uuid, uuid, jsonb)',
    'app.reporte_no_calificados(uuid, timestamptz)',
    'app.reportes_no_calificados()'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
