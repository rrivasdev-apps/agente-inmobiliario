-- =============================================================================
-- Agendamiento con GoHighLevel en el flujo de n8n (Etapas 3 y 4).
--
-- Al calificar, n8n registra el contacto en GoHighLevel, consulta horarios
-- libres y los ofrece; cuando la persona elige uno, reserva la cita. La BD
-- guarda los horarios ofrecidos (AC 30: solo se reserva uno de ellos) y
-- aplica las transiciones de estado.
-- =============================================================================

-- Horarios ofrecidos y pendientes de elección: {ofrecidos: [iso], texto, ofrecido_en}
alter table app.conversaciones
  add column agenda jsonb not null default '{}'::jsonb
  check (jsonb_typeof(agenda) = 'object');

-- El contexto agrega lo que necesita el agendamiento. La versión anterior
-- queda como app.contexto_base y todas las funciones siguen llamando a
-- app.contexto_conversacion.
alter function app.contexto_conversacion(uuid, uuid) rename to contexto_base;

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

-- registrar_datos devuelve además la elección de horario que extrajo el LLM.
create or replace function app.registrar_datos_y_seleccion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language sql
as $$
  select app.registrar_datos(p_tenant, p_conversacion, p)
         || jsonb_build_object('seleccion', coalesce(p->'seleccion', 'null'::jsonb));
$$;

-- Cambia el estado solo si la máquina de estados lo permite.
create or replace function app.transicionar_si_permitido(p_tenant uuid, p_contacto uuid, p_destino app.estado_contacto, p_motivo text default null)
returns boolean
language plpgsql
as $$
declare
  v_actual app.estado_contacto;
begin
  select estado into v_actual from app.contactos where tenant_id = p_tenant and id = p_contacto;
  if v_actual = p_destino then
    return true;
  end if;
  if not exists (select 1 from app.transiciones_estado where desde = v_actual and hacia = p_destino) then
    return false;
  end if;
  update app.contactos set estado = p_destino, motivo_estado = p_motivo
  where tenant_id = p_tenant and id = p_contacto;
  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Evaluación: ya no hace retroceder a un contacto que está agendando.
-- -----------------------------------------------------------------------------

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
    tenant_id, conversacion_id, contacto_id, rol_codigo, resultado, campos_faltantes, criterios, motivo)
  values (
    p_tenant, p_conversacion, v_conv.contacto_id, v_conv.rol_codigo,
    (v_eval->>'resultado')::app.resultado_calificacion,
    coalesce((select array_agg(x) from jsonb_array_elements_text(v_eval->'campos_faltantes') x), '{}'),
    jsonb_build_object('accion', v_eval->'accion', 'codigo_motivo', v_eval->'codigo_motivo', 'reglas', coalesce(v_eval->'reglas', '[]'::jsonb)),
    v_eval->>'motivo');

  v_destino := case v_eval->>'resultado'
    when 'calificado' then 'calificado_pendiente_agendamiento'
    when 'no_calificado' then 'no_calificado'
    else 'informacion_incompleta'
  end;
  v_motivo := case when v_destino = 'no_calificado' then coalesce(v_eval->>'codigo_motivo', v_eval->>'motivo') end;

  -- La evaluación solo mueve el estado durante la calificación; después, el
  -- agendamiento (registrar_oferta, registrar_cita) es dueño del estado.
  if v_anterior in ('en_calificacion', 'informacion_incompleta')
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
-- Oferta de horarios
--
-- p: {ghl_contact_id?, ofrecidos: [iso], texto, motivo: 'ofrecidos' | 'agotado',
--     error?: {...}, eventos?: [...]}
-- Devuelve el contexto con resultado_agenda.tipo:
--   'ofrecidos' | 'agotado' | 'sin_disponibilidad' | 'error'
-- -----------------------------------------------------------------------------

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
    || jsonb_build_object('resultado_agenda', jsonb_build_object('tipo', v_tipo, 'texto', p->>'texto'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Reserva
--
-- p: {inicio, modalidad, zona_horaria, resultado: salida de
--     interpretarCrearCita, fecha_texto, hora_texto, zona_texto, eventos?: [...]}
-- resultado_agenda.tipo: 'confirmada' | 'pendiente_confirmacion' | 'agotado' | 'error'
-- -----------------------------------------------------------------------------

create or replace function app.registrar_cita(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_conv    app.conversaciones;
  v_res     jsonb := p->'resultado';
  v_asesor  uuid;
  v_tipo    text;
  v_estado  app.estado_cita;
begin
  perform app.registrar_eventos(p_tenant, p_conversacion, p->'eventos');
  select * into v_conv from app.conversaciones where tenant_id = p_tenant and id = p_conversacion;

  if coalesce(v_res->>'id_externo', '') <> '' then
    v_estado := coalesce((v_res->>'estado_cita')::app.estado_cita, 'confirmada');
    select id into v_asesor from app.asesores
    where tenant_id = p_tenant and ghl_user_id = v_res->>'asesor_ghl_user_id' and activo;

    -- AC 40: si la misma cita ya está registrada (reintento), se reutiliza.
    insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad,
                           proveedor, id_externo, estado, asesor_id, respuesta_proveedor)
    values (p_tenant, v_conv.contacto_id, p_conversacion, v_conv.rol_codigo,
            coalesce((v_res->>'inicio')::timestamptz, (p->>'inicio')::timestamptz),
            p->>'zona_horaria', coalesce(p->>'modalidad', 'llamada'),
            'gohighlevel_calendar', v_res->>'id_externo', v_estado, v_asesor, v_res)
    on conflict (tenant_id, proveedor, id_externo) where id_externo is not null do nothing;

    update app.conversaciones set agenda = '{}' where tenant_id = p_tenant and id = p_conversacion;

    if v_estado = 'confirmada' then
      v_tipo := 'confirmada';
      perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'cita_confirmada');
    else
      -- El calendario exige confirmación manual: la cita existe pero no está confirmada (AC 32).
      v_tipo := 'pendiente_confirmacion';
      perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'seleccion_pendiente_confirmacion');
    end if;
  elsif v_res->>'motivo' = 'horario_no_disponible' then
    -- AC 39: el horario se ocupó; n8n consulta y ofrece alternativas.
    v_tipo := 'agotado';
    update app.conversaciones set agenda = '{}' where tenant_id = p_tenant and id = p_conversacion;
  else
    v_tipo := 'error';
    update app.conversaciones set agenda = '{}' where tenant_id = p_tenant and id = p_conversacion;
    perform app.transicionar_si_permitido(p_tenant, v_conv.contacto_id, 'error_agendamiento');
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'gohighlevel_calendar', 'operacion', 'reservar_cita',
      'mensaje', 'GoHighLevel no confirmó la reserva', 'contexto', coalesce(v_res, '{}'::jsonb))));
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion)
    || jsonb_build_object('resultado_agenda', jsonb_build_object(
         'tipo', v_tipo, 'fecha', p->>'fecha_texto', 'hora', p->>'hora_texto',
         'zona_horaria', p->>'zona_horaria', 'zona_texto', p->>'zona_texto', 'modalidad', p->>'modalidad'));
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.contexto_conversacion(uuid, uuid)',
    'app.registrar_datos_y_seleccion(uuid, uuid, jsonb)',
    'app.transicionar_si_permitido(uuid, uuid, app.estado_contacto, text)',
    'app.registrar_oferta(uuid, uuid, jsonb)',
    'app.registrar_cita(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
