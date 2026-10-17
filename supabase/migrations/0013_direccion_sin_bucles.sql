-- =============================================================================
-- Dirección imprecisa sin bucles.
--
-- En la prueba del 17 oct la dirección quedó "ambigua" y el agente repitió el
-- mismo mensaje en cada turno: si la persona no cambiaba la dirección no se
-- volvía a verificar y no había salida.
--
-- * La consulta a Google usa dirección y ciudad. El barrio se sigue pidiendo,
--   pero un barrio equivocado volvía imprecisa una dirección que sí existe.
-- * Si la persona vuelve a dar la dirección tras un resultado impreciso, se
--   verifica otra vez; un segundo resultado impreciso para la misma dirección
--   queda como no_verificada (D19: tras dos intentos, no calificado).
-- =============================================================================

create or replace function app.direccion_completa(p_datos jsonb)
returns text
language sql
immutable
as $$
  select case
    when coalesce(btrim(p_datos->>'direccion'), '') = ''
      or coalesce(btrim(p_datos->>'barrio'), '') = ''
      or coalesce(btrim(p_datos->>'ciudad'), '') = '' then ''
    else concat_ws(', ', btrim(p_datos->>'direccion'), btrim(p_datos->>'ciudad'))
  end;
$$;

create or replace function app.registrar_verificacion(p_tenant uuid, p_conversacion uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_contacto  app.contactos;
  v_resultado app.resultado_verificacion;
begin
  select ct.* into v_contacto
  from app.conversaciones c join app.contactos ct on ct.tenant_id = c.tenant_id and ct.id = c.contacto_id
  where c.tenant_id = p_tenant and c.id = p_conversacion;

  if p->>'resultado' = 'sin_resultados' then
    v_resultado := case when exists (
      select 1 from app.verificaciones_direccion
      where tenant_id = p_tenant and conversacion_id = p_conversacion and resultado <> 'error'
    ) then 'no_verificada' else 'ambigua' end;
  else
    v_resultado := (p->>'resultado')::app.resultado_verificacion;
  end if;
  -- Segundo intento impreciso con la misma dirección: no se pudo verificar
  -- (decisión D19: tras dos intentos, no calificado). Evita pedirla sin fin.
  if v_resultado = 'ambigua' and exists (
    select 1 from app.verificaciones_direccion
    where tenant_id = p_tenant and contacto_id = v_contacto.id
      and direccion_original = app.direccion_completa(v_contacto.datos) and resultado = 'ambigua'
  ) then
    v_resultado := 'no_verificada';
  end if;

  insert into app.verificaciones_direccion (
    tenant_id, contacto_id, conversacion_id, direccion_original, direccion_normalizada,
    latitud, longitud, place_id, resultado, respuesta_proveedor)
  values (
    p_tenant, v_contacto.id, p_conversacion, app.direccion_completa(v_contacto.datos), p->>'direccion_normalizada',
    (p->>'latitud')::double precision, (p->>'longitud')::double precision, p->>'place_id', v_resultado,
    p->'respuesta_proveedor');

  if v_resultado = 'error' then
    perform app.registrar_eventos(p_tenant, p_conversacion, jsonb_build_array(jsonb_build_object(
      'nivel', 'error', 'proveedor', 'google_maps', 'operacion', 'verificar_direccion',
      'mensaje', 'Falló la consulta a Google Maps', 'contexto', p->'respuesta_proveedor')));
  end if;

  return app.contexto_conversacion(p_tenant, p_conversacion);
end;
$$;

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
           || jsonb_build_object('seleccion', coalesce(p->'seleccion', 'null'::jsonb));
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

do $$
declare
  f text;
begin
  foreach f in array array[
    'app.registrar_verificacion(uuid, uuid, jsonb)',
    'app.registrar_datos_y_seleccion(uuid, uuid, jsonb)'
  ] loop
    execute format('revoke execute on function %s from public, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
