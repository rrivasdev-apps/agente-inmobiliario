-- =============================================================================
-- Horarios ya ocupados.
--
-- En la prueba del 17 oct el calendario de GoHighLevel devolvió como libre un
-- horario que ya tenía una llamada (el calendario admite más de una cita por
-- horario). El contexto informa el inicio de las citas activas futuras del
-- tenant y el agente no ofrece esos horarios.
-- =============================================================================

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
  -- Las ciudades atendidas salen de app.ciudades_cobertura cuando el tenant
  -- tiene filas ahí (activas o no); si no, del parámetro cobertura.ciudades.
  if exists (select 1 from app.ciudades_cobertura where tenant_id = p_tenant) then
    v_ctx := jsonb_set(v_ctx, '{tenant,parametros}', coalesce(v_ctx->'tenant'->'parametros', '{}'::jsonb) || jsonb_build_object(
      'cobertura', coalesce(v_ctx->'tenant'->'parametros'->'cobertura', '{}'::jsonb) || jsonb_build_object(
        'ciudades', coalesce((select jsonb_agg(ciudad order by ciudad) from app.ciudades_cobertura
                              where tenant_id = p_tenant and activa), '[]'::jsonb))));
  end if;
  -- Historial con la hora de cada mensaje: la extracción lee solo los del caso actual.
  v_ctx := v_ctx || jsonb_build_object('historial', coalesce((
    select jsonb_agg(jsonb_build_object('direccion', direccion, 'remitente', remitente, 'contenido', contenido, 'creado_en', creado_en)
                     order by creado_en, id)
    from (
      select * from app.mensajes
      where tenant_id = p_tenant and conversacion_id = p_conversacion
      order by creado_en desc, id desc
      limit 30
    ) m), '[]'::jsonb));
  -- Inicio de las citas activas futuras del tenant: el agente no ofrece esos
  -- horarios aunque el calendario los devuelva libres (si permite más de una
  -- cita por horario).
  v_ctx := v_ctx || jsonb_build_object('horarios_ocupados', coalesce((
    select jsonb_agg(inicio order by inicio) from (
      select inicio from app.citas
      where tenant_id = p_tenant and inicio > now()
        and estado in ('seleccion_pendiente', 'confirmada', 'reprogramada')
      order by inicio
      limit 500) x), '[]'::jsonb));
  v_ctx := v_ctx || jsonb_build_object('retorno', v_retorno);
  -- Citas del contacto ya registradas en el proveedor (todas sus oportunidades):
  -- la conciliación con GoHighLevel no las reutiliza para otra reserva.
  v_ctx := v_ctx || jsonb_build_object('citas_externas', coalesce((
    select jsonb_agg(id_externo) from app.citas
    where tenant_id = p_tenant and contacto_id = v_conv.contacto_id and id_externo is not null), '[]'::jsonb));
  v_ctx := v_ctx || jsonb_build_object('oportunidad', (
    select jsonb_build_object(
      'id', o.id,
      'creada_en', o.creada_en,
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

revoke execute on function app.contexto_conversacion(uuid, uuid) from public, authenticated;
grant execute on function app.contexto_conversacion(uuid, uuid) to service_role;
