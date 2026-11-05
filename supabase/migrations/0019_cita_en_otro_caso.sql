begin;
-- =============================================================================
-- Varias propiedades, una o varias llamadas (lineamientos de Rafael, 5 nov 2026).
--
-- Una persona puede tener varios casos. Si la propiedad nueva califica y ya hay
-- una llamada agendada en otro caso, se le pregunta si quiere verlas en esa misma
-- llamada o por separado. Para eso el contexto trae la próxima cita de sus otros casos.
-- =============================================================================

alter function app.contexto_conversacion(uuid, uuid) rename to contexto_sin_otro_caso;

create or replace function app.contexto_conversacion(p_tenant uuid, p_conversacion uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_ctx jsonb := app.contexto_sin_otro_caso(p_tenant, p_conversacion);
begin
  return v_ctx || jsonb_build_object('cita_otro_caso', (
    select jsonb_build_object('inicio', ci.inicio, 'modalidad', ci.modalidad)
    from app.citas ci
    where ci.tenant_id = p_tenant
      and ci.contacto_id = (v_ctx->'contacto'->>'id')::uuid
      and ci.oportunidad_id is distinct from (v_ctx->'oportunidad'->>'id')::uuid
      and ci.estado in ('confirmada', 'reprogramada')
      and ci.inicio > now()
    order by ci.inicio
    limit 1));
end;
$$;

revoke execute on function app.contexto_sin_otro_caso(uuid, uuid) from public, authenticated;
revoke execute on function app.contexto_conversacion(uuid, uuid) from public, authenticated;
grant execute on function app.contexto_sin_otro_caso(uuid, uuid) to service_role;
grant execute on function app.contexto_conversacion(uuid, uuid) to service_role;

commit;
