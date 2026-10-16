-- =============================================================================
-- Cambio de asistente y referencia fuera de cobertura.
--
-- * El extractor marca cambio_intencion ('comprar' | 'vender') cuando quien
--   hablaba con Lucía quiere comprar, o con Sonia quiere vender. La
--   conversación pasa a la otra asistente en una oportunidad nueva: se
--   conserva la ficha de contacto y no se mezclan los datos de la necesidad
--   anterior.
-- * El contexto informa el rol de la oportunidad anterior, para que la nueva
--   asistente se presente.
-- * El reporte de no calificados muestra si la persona autorizó compartir sus
--   datos para una posible referencia (la referencia queda pendiente; marcarla
--   como realizada es una gestión manual).
-- =============================================================================

create or replace function app.cambiar_rol(p_tenant uuid, p_conversacion uuid, p_rol app.codigo_rol)
returns boolean
language plpgsql
as $$
declare
  v_conv    app.conversaciones;
  v_op      uuid;
begin
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;
  if v_conv.rol_codigo is not distinct from p_rol
     or not exists (select 1 from app.roles_agente where tenant_id = p_tenant and codigo = p_rol and activo) then
    return false;
  end if;

  -- Si el caso actual tenía datos, se guarda y se abre otro; si no, el mismo cambia de rol.
  perform app.nueva_oportunidad(p_tenant, p_conversacion);
  update app.conversaciones set rol_codigo = p_rol, agenda = '{}'::jsonb
  where tenant_id = p_tenant and id = p_conversacion;
  select oportunidad_id into v_op from app.contactos where tenant_id = p_tenant and id = v_conv.contacto_id;
  update app.oportunidades set rol_codigo = p_rol where tenant_id = p_tenant and id = v_op;
  return true;
end;
$$;

create or replace function app.registrar_datos_y_seleccion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
begin
  -- Quien hablaba con Lucía y quiere comprar (o con Sonia y quiere vender)
  -- pasa a la otra asistente en un caso nuevo, con la misma ficha de contacto.
  if p->>'cambio_intencion' in ('comprar', 'vender') then
    perform app.cambiar_rol(p_tenant, p_conversacion,
      case p->>'cambio_intencion' when 'comprar' then 'sonia' else 'lucia' end::app.codigo_rol);
  elsif p->'nueva_propiedad' = 'true'::jsonb then
    perform app.nueva_oportunidad(p_tenant, p_conversacion);
  end if;
  if p->'misma_cita' = 'true'::jsonb then
    perform app.compartir_cita(p_tenant, p_conversacion);
  end if;
  return app.registrar_datos(p_tenant, p_conversacion, p)
         || jsonb_build_object('seleccion', coalesce(p->'seleccion', 'null'::jsonb));
end;
$$;

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
  v_ultimo   timestamptz;
  v_retorno  jsonb;
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

  -- Primer mensaje de una conversación que reemplaza a otra cerrada por
  -- inactividad: el agente saluda a quien regresa.
  if v_conv.conversacion_anterior_id is not null and (
    select count(*) from app.mensajes
    where tenant_id = p_tenant and conversacion_id = p_conversacion and direccion = 'entrante') <= 1 then
    v_ultimo := app.ultima_actividad(p_tenant, v_conv.conversacion_anterior_id);
    v_retorno := jsonb_build_object(
      'ultimo_contacto_en', v_ultimo,
      'horas_sin_contacto', floor(extract(epoch from (v_conv.creado_en - v_ultimo)) / 3600),
      'ahora', now());
  end if;
  v_ctx := v_ctx || jsonb_build_object('retorno', v_retorno);
  v_ctx := v_ctx || jsonb_build_object('oportunidad', (
    select jsonb_build_object(
      'id', o.id,
      'anteriores', (select count(*) from app.oportunidades x where x.tenant_id = p_tenant and x.contacto_id = o.contacto_id and x.id <> o.id),
      'nota_asesor_en', o.nota_asesor_en,
      'rol_anterior', (select x.rol_codigo from app.oportunidades x
                       where x.tenant_id = p_tenant and x.contacto_id = o.contacto_id and x.id <> o.id
                       order by x.creada_en desc limit 1),
      'cita_compartida', (
        select jsonb_build_object('id', ci.id, 'inicio', ci.inicio, 'estado', ci.estado, 'modalidad', ci.modalidad)
        from app.citas ci
        where ci.id = o.cita_compartida_id and ci.estado in ('confirmada', 'reprogramada') and ci.inicio > now()))
    from app.oportunidades o
    where o.tenant_id = p_tenant and o.id = v_contacto.oportunidad_id));

  return v_ctx || jsonb_build_object('cita', (
    select jsonb_build_object('id', id, 'inicio', inicio, 'zona_horaria', zona_horaria,
                              'modalidad', modalidad, 'estado', estado)
    from app.citas
    where tenant_id = p_tenant and contacto_id = v_conv.contacto_id
      and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
      and oportunidad_id is not distinct from v_contacto.oportunidad_id
    order by creado_en desc
    limit 1));
end;
$$;

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
             'plazo_meses', coalesce(c.datos->>'plazo_meses', c.datos->>'horizonte_compra_meses'),
             'autoriza_referencia', c.datos->'autoriza_referencia'
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

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.cambiar_rol(uuid, uuid, app.codigo_rol)',
    'app.registrar_datos_y_seleccion(uuid, uuid, jsonb)',
    'app.contexto_conversacion(uuid, uuid)',
    'app.reporte_no_calificados(uuid, timestamptz)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
