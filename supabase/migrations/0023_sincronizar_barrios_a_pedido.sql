begin;
-- =============================================================================
-- Sincronización de barrios a pedido desde el panel (27 nov 2026).
--
-- La sincronización automática pasa de cada 15 minutos a una vez al día, para
-- no agotar el cupo de ejecuciones de n8n Cloud. Para no esperar al día
-- siguiente, un admin del tenant la pide desde el panel (Cobertura → Barrios):
--
--   panel ──rpc──▶ app.solicitar_sincronizacion_barrios ──pg_net──▶ webhook de n8n
--
-- El panel no guarda ningún secreto: la BD verifica que la persona sea admin y
-- llama a n8n con un token que vive solo en Vault (n8n_barrios_token). n8n
-- comprueba ese token con app.verificar_token_barrios antes de leer la hoja.
-- =============================================================================

create extension if not exists pg_net with schema extensions;

-- Token aleatorio generado aquí mismo: nunca pasa por el repositorio ni por el chat.
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'n8n_barrios_token',
                           'Token del webhook de n8n que sincroniza los barrios a pedido')
where not exists (select 1 from vault.secrets where name = 'n8n_barrios_token');

-- La URL no es secreta; va en Vault para poder cambiarla sin otra migración.
select vault.create_secret('https://rersn8n.app.n8n.cloud/webhook/agente-inmobiliario/barrios', 'n8n_barrios_url',
                           'Webhook de n8n que sincroniza los barrios a pedido')
where not exists (select 1 from vault.secrets where name = 'n8n_barrios_url');

create or replace function app.verificar_token_barrios(p_token text)
returns boolean
language sql
stable
as $$
  select coalesce(p_token <> '' and p_token = app.secreto_vault('n8n_barrios_token'), false);
$$;

-- Pedidos con menos de 2 minutos de diferencia se ignoran: la sincronización tarda
-- unos segundos y cada pedido gasta una ejecución de n8n.
create or replace function app.solicitar_sincronizacion_barrios(p_tenant uuid)
returns jsonb
language plpgsql
security definer
set search_path = app, pg_temp
as $$
declare
  v_url   text := app.secreto_vault('n8n_barrios_url');
  v_token text := app.secreto_vault('n8n_barrios_token');
begin
  if not app.es_admin_de(p_tenant) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
  if v_url is null or v_token is null then
    return jsonb_build_object('ok', false, 'motivo', 'sin_configurar');
  end if;
  if exists (
    select 1 from app.eventos
    where tenant_id = p_tenant and operacion = 'solicitar_sincronizacion_barrios'
      and creado_en > now() - interval '2 minutes'
  ) then
    return jsonb_build_object('ok', false, 'motivo', 'reciente');
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('tenant', (select slug from app.tenants where id = p_tenant)),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Token', v_token),
    timeout_milliseconds := 10000);

  insert into app.eventos (tenant_id, nivel, operacion, entidad, mensaje, contexto)
  values (p_tenant, 'info', 'solicitar_sincronizacion_barrios', 'barrios_cobertura',
          'Sincronización de barrios pedida desde el panel', jsonb_build_object('usuario', auth.uid()));
  return jsonb_build_object('ok', true);
end;
$$;

-- Para el panel: cuándo fue la última sincronización y el último pedido.
create or replace function app.estado_sincronizacion_barrios(p_tenant uuid)
returns jsonb
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select case when exists (
    select 1 from app.miembros_tenant where user_id = auth.uid() and tenant_id = p_tenant
  ) then jsonb_build_object(
    'ultima', (select jsonb_build_object('fecha', creado_en, 'mensaje', mensaje)
               from app.eventos where tenant_id = p_tenant and operacion = 'sincronizar_barrios'
               order by creado_en desc limit 1),
    'pedida', (select creado_en from app.eventos
               where tenant_id = p_tenant and operacion = 'solicitar_sincronizacion_barrios'
               order by creado_en desc limit 1))
  end;
$$;

revoke execute on function app.verificar_token_barrios(text) from public, anon, authenticated;
revoke execute on function app.solicitar_sincronizacion_barrios(uuid) from public, anon;
revoke execute on function app.estado_sincronizacion_barrios(uuid) from public, anon;
grant execute on function app.verificar_token_barrios(text) to service_role;
grant execute on function app.solicitar_sincronizacion_barrios(uuid) to authenticated;
grant execute on function app.estado_sincronizacion_barrios(uuid) to authenticated;

commit;
