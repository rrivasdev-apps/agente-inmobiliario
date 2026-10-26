-- =============================================================================
-- Redacción guiada y guion de Lucía (26 oct 2026).
--
-- * Las plantillas que no requieren aprobación de Meta son guías: el agente
--   las redacta con sus palabras. El contexto informa cuáles van literales
--   (plantillas_literales) y el historial trae la clave de la plantilla de
--   cada mensaje, para reconocer un mensaje ya enviado aunque cambie el texto.
-- * Cobertura por barrio al calificar: con la ciudad y el barrio dados, el
--   contexto trae las filas activas de app.barrios_cobertura (0016) para que
--   src/cobertura/barrios.js resuelva si se atiende.
-- * Prioridad B = agendar a futuro: una evaluación calificada de prioridad
--   baja con accion ofrecer_agenda va a calificado_pendiente_agendamiento, no
--   a nutricion. Sin accion (o con nutrir) se mantiene el comportamiento de 0005.
-- =============================================================================

alter function app.contexto_conversacion(uuid, uuid) rename to contexto_con_agenda;

create or replace function app.contexto_conversacion(p_tenant uuid, p_conversacion uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_ctx    jsonb := app.contexto_con_agenda(p_tenant, p_conversacion);
  v_barrio text  := v_ctx->'contacto'->'datos'->>'barrio';
begin
  -- Mismo historial que 0014, más la clave de la plantilla de cada mensaje.
  v_ctx := v_ctx || jsonb_build_object('historial', coalesce((
    select jsonb_agg(jsonb_build_object('direccion', m.direccion, 'remitente', m.remitente, 'contenido', m.contenido,
                                        'creado_en', m.creado_en, 'plantilla', pl.clave)
                     order by m.creado_en, m.id)
    from (
      select * from app.mensajes
      where tenant_id = p_tenant and conversacion_id = p_conversacion
      order by creado_en desc, id desc
      limit 30
    ) m
    left join app.plantillas pl on pl.tenant_id = m.tenant_id and pl.id = m.plantilla_id), '[]'::jsonb));

  v_ctx := v_ctx || jsonb_build_object('plantillas_literales', coalesce((
    select jsonb_agg(distinct clave) from app.plantillas
    where tenant_id = p_tenant and requiere_aprobacion_meta), '[]'::jsonb));

  if coalesce((v_ctx->'rol'->>'requiere_verificacion_direccion')::boolean, false) and coalesce(btrim(v_barrio), '') <> '' then
    v_ctx := v_ctx || jsonb_build_object('barrios_cobertura', coalesce((
      select jsonb_agg(jsonb_build_object('localidad', localidad, 'codigo_upz', codigo_upz, 'upz', upz,
                                          'barrio', barrio, 'alias', alias, 'atiende', atiende))
      from app.barrios_cobertura
      where tenant_id = p_tenant and activo), '[]'::jsonb));
  end if;

  return v_ctx;
end;
$$;

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
    jsonb_build_object('accion', v_eval->'accion', 'codigo_motivo', v_eval->'codigo_motivo', 'reglas', coalesce(v_eval->'reglas', '[]'::jsonb),
                       'agendar_desde_dias', v_eval->'agendar_desde_dias'),
    v_eval->>'motivo', v_eval->>'prioridad');

  v_destino := case v_eval->>'resultado'
    when 'calificado' then
      case when v_eval->>'prioridad' = 'baja' and coalesce(v_eval->>'accion', 'nutrir') = 'nutrir'
           then 'nutricion' else 'calificado_pendiente_agendamiento' end
    when 'no_calificado' then 'no_calificado'
    else 'informacion_incompleta'
  end;
  v_motivo := case when v_destino = 'no_calificado' then coalesce(v_eval->>'codigo_motivo', v_eval->>'motivo') end;

  -- La evaluación solo mueve el estado durante la calificación; después, el
  -- agendamiento (registrar_oferta, registrar_cita) es dueño del estado.
  -- Un no calificado que corrige un dato (otra ciudad, otro inmueble) se
  -- vuelve a evaluar.
  if v_anterior in ('en_calificacion', 'informacion_incompleta', 'nutricion', 'no_calificado')
     and v_destino <> v_anterior and exists (
    select 1 from app.transiciones_estado where desde = v_anterior and hacia = v_destino
  ) then
    update app.contactos set estado = v_destino, motivo_estado = v_motivo
    where tenant_id = p_tenant and id = v_conv.contacto_id;
  end if;

  -- Propiedad que se revisa en una reunión ya agendada: al calificar queda con esa cita.
  if v_eval->>'resultado' = 'calificado' and exists (
    select 1
    from app.contactos ct
    join app.oportunidades o on o.tenant_id = ct.tenant_id and o.id = ct.oportunidad_id
    join app.citas ci on ci.id = o.cita_compartida_id
    where ct.tenant_id = p_tenant and ct.id = v_conv.contacto_id
      and ci.estado in ('confirmada', 'reprogramada') and ci.inicio > now()
  ) then
    perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'calificado_pendiente_agendamiento');
    perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'cita_confirmada');
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('evaluacion', v_eval, 'estado_anterior', v_anterior);
end;
$$;

revoke execute on function app.contexto_con_agenda(uuid, uuid) from public, authenticated;
revoke execute on function app.contexto_conversacion(uuid, uuid) from public, authenticated;
revoke execute on function app.guardar_evaluacion(uuid, uuid, jsonb) from public, authenticated;
grant execute on function app.contexto_con_agenda(uuid, uuid) to service_role;
grant execute on function app.contexto_conversacion(uuid, uuid) to service_role;
grant execute on function app.guardar_evaluacion(uuid, uuid, jsonb) to service_role;
