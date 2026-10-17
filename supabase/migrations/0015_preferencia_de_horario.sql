-- =============================================================================
-- Preferencia de horario.
--
-- Si la persona no elige de la lista y pide otro día o franja ("otra opción
-- el miércoles"), el extractor devuelve preferencia_horario y el flujo vuelve
-- a consultar el calendario para ese día. registrar_datos_y_seleccion la
-- devuelve al flujo y registrar_oferta informa el día pedido a la plantilla.
-- =============================================================================

create or replace function app.registrar_datos_y_seleccion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_ctx jsonb;
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
  v_ctx := app.registrar_datos(p_tenant, p_conversacion, p)
           || jsonb_build_object('seleccion', coalesce(p->'seleccion', 'null'::jsonb),
                                 'preferencia_horario', coalesce(p->'preferencia_horario', 'null'::jsonb));
  -- La persona volvió a dar la dirección (aunque sea la misma) tras un
  -- resultado impreciso: se verifica otra vez (segundo intento).
  if (p->'datos') ?| array['direccion', 'barrio', 'ciudad']
     and v_ctx->>'direccion_a_verificar' is not null
     and v_ctx->'verificacion'->>'resultado' = 'ambigua' then
    v_ctx := v_ctx || jsonb_build_object('verificacion_pendiente', true);
  end if;
  return v_ctx;
end;
$$;

create or replace function app.registrar_oferta(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_contacto uuid;
  v_tipo     text;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');
  select contacto_id into v_contacto from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;

  -- AC 25: se guarda el id del contacto en GoHighLevel.
  if coalesce(p->>'ghl_contact_id', '') <> '' then
    begin
      update app.contactos set ghl_contact_id = p->>'ghl_contact_id'
      where tenant_id = p_tenant and id = v_contacto and ghl_contact_id is distinct from p->>'ghl_contact_id';
    exception when unique_violation then
      perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
        'nivel', 'advertencia', 'proveedor', 'gohighlevel', 'operacion', 'upsert_contacto',
        'mensaje', 'Otro contacto del tenant ya tiene este ghl_contact_id', 'contexto', jsonb_build_object('ghl_contact_id', p->>'ghl_contact_id'))));
    end;
  end if;

  if p->'error' is not null and p->'error' <> 'null'::jsonb then
    v_tipo := 'error';
    update app.conversaciones set agenda = '{}' where tenant_id = p_tenant and id = p_conversacion;
    perform app.transicionar_si_permitido(p_tenant, v_contacto, 'error_agendamiento');
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'gohighlevel', 'operacion', 'consultar_disponibilidad',
      'mensaje', 'No fue posible registrar el contacto u obtener horarios en GoHighLevel', 'contexto', p->'error')));
  elsif jsonb_array_length(coalesce(p->'ofrecidos', '[]')) = 0 then
    v_tipo := 'sin_disponibilidad';
    update app.conversaciones set agenda = '{}' where tenant_id = p_tenant and id = p_conversacion;
    perform app.transicionar_si_permitido(p_tenant, v_contacto, 'sin_disponibilidad');
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'advertencia', 'proveedor', 'gohighlevel_calendar', 'operacion', 'consultar_disponibilidad',
      'mensaje', 'El calendario no tiene horarios libres en el rango consultado')));
  else
    v_tipo := coalesce(nullif(p->>'motivo', ''), 'ofrecidos');
    update app.conversaciones
    set agenda = jsonb_build_object('ofrecidos', p->'ofrecidos', 'texto', p->>'texto', 'ofrecido_en', now())
    where tenant_id = p_tenant and id = p_conversacion;
    -- Tras una falla o falta de disponibilidad, vuelve a estar pendiente de agendar.
    perform app.transicionar_si_permitido(p_tenant, v_contacto, 'calificado_pendiente_agendamiento');
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('resultado_agenda', jsonb_build_object('tipo', v_tipo, 'texto', p->>'texto', 'dia', p->>'dia'));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.registrar_datos_y_seleccion(uuid, uuid, jsonb)',
    'app.registrar_oferta(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
