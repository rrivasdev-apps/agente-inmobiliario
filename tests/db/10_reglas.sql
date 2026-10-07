-- Pruebas de reglas de negocio e aislamiento multiempresa.
-- Cada bloque falla con una excepción si una regla no se cumple.
\set ON_ERROR_STOP on

create or replace function pg_temp.debe_fallar(p_sql text, p_patron text)
returns void language plpgsql as $$
declare
  v_fallo boolean := false;
begin
  begin
    execute p_sql;
  exception when others then
    v_fallo := true;
    if sqlerrm not like '%' || p_patron || '%' then
      raise exception 'Error inesperado para "%": %', p_sql, sqlerrm;
    end if;
  end;
  if not v_fallo then
    raise exception 'Se esperaba un error que contenga "%" para: %', p_patron, p_sql;
  end if;
end;
$$;

-- Escenario: dos tenants -------------------------------------------------------
insert into app.tenants (id, slug, nombre) values
  ('00000000-0000-0000-0000-0000000000b1', 'tenant-b', 'Tenant B');
insert into app.miembros_tenant (tenant_id, user_id, rol) values
  ((select id from app.tenants where slug = 'javier-nunez'), '11111111-1111-1111-1111-111111111111', 'admin_operacion'),
  ('00000000-0000-0000-0000-0000000000b1', '22222222-2222-2222-2222-222222222222', 'admin_operacion');

create temp table ids as
select
  (select id from app.tenants where slug = 'javier-nunez') as ta,
  '00000000-0000-0000-0000-0000000000b1'::uuid as tb,
  (select id from app.canales where tipo = 'whatsapp' and tenant_id = (select id from app.tenants where slug = 'javier-nunez')) as canal_a;
grant select on ids to authenticated;

insert into app.canales (tenant_id, tipo, identificador_externo)
  values ((select tb from ids), 'whatsapp', 'WA_TENANT_B');
insert into app.asesores (id, tenant_id, nombre)
  values ('aaaaaaaa-0000-0000-0000-000000000001', (select ta from ids), 'Asesor A');
insert into app.contactos (id, tenant_id, nombre, telefono, canal_origen, rol_origen)
  values ('c0000000-0000-0000-0000-00000000000a', (select ta from ids), 'Ana', '+573001112233', 'whatsapp', 'lucia');
insert into app.conversaciones (id, tenant_id, contacto_id, canal_id, rol_codigo)
  values ('d0000000-0000-0000-0000-00000000000a', (select ta from ids), 'c0000000-0000-0000-0000-00000000000a', (select canal_a from ids), 'lucia');

do $$ begin raise notice 'OK seed y escenario base'; end $$;

-- AC 01 / AC 02: claves compuestas impiden mezclar tenants ----------------------
select pg_temp.debe_fallar(
  format($q$insert into app.conversaciones (tenant_id, contacto_id, canal_id)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', %L)$q$,
         (select tb from ids), (select canal_a from ids)),
  'violates foreign key');

select pg_temp.debe_fallar(
  $q$insert into app.contactos (nombre, canal_origen) values ('sin tenant', 'whatsapp')$q$,
  'null value in column "tenant_id"');

-- AC 05: el canal resuelve un único tenant
select pg_temp.debe_fallar(
  format($q$insert into app.canales (tenant_id, tipo, identificador_externo) values (%L, 'whatsapp', 'WA_TENANT_B')$q$,
         (select ta from ids)),
  'duplicate key');

-- AC 23: duplicados por teléfono y correo
select pg_temp.debe_fallar(
  format($q$insert into app.contactos (tenant_id, telefono, canal_origen) values (%L, '+573001112233', 'instagram_dm')$q$,
         (select ta from ids)),
  'contactos_telefono_unico');
-- ... pero el mismo teléfono sí puede existir en otro tenant
insert into app.contactos (tenant_id, telefono, canal_origen) values ((select tb from ids), '+573001112233', 'whatsapp');

-- AC 20: Sonia no verifica direcciones
update app.conversaciones set rol_codigo = 'sonia' where id = 'd0000000-0000-0000-0000-00000000000a';
select pg_temp.debe_fallar(
  format($q$insert into app.verificaciones_direccion (tenant_id, contacto_id, conversacion_id, direccion_original, resultado)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 'Calle 1', 'verificada')$q$,
         (select ta from ids)),
  'Solo las conversaciones de Lucía');
update app.conversaciones set rol_codigo = 'lucia' where id = 'd0000000-0000-0000-0000-00000000000a';
insert into app.verificaciones_direccion (tenant_id, contacto_id, conversacion_id, direccion_original, direccion_normalizada, resultado)
  values ((select ta from ids), 'c0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a',
          'cll 63 9 15', 'Cl. 63 #9-15, Bogotá', 'verificada');

do $$ begin raise notice 'OK aislamiento, duplicados y verificación'; end $$;

-- Máquina de estados ----------------------------------------------------------
select pg_temp.debe_fallar(
  $q$update app.contactos set estado = 'entregado_asesor' where id = 'c0000000-0000-0000-0000-00000000000a'$q$,
  'Transición de estado no permitida');

select pg_temp.debe_fallar(
  $q$update app.contactos set estado = 'no_calificado' where id = 'c0000000-0000-0000-0000-00000000000a'$q$,
  'contactos_check');  -- AC 43: requiere motivo

update app.contactos set estado = 'calificado_pendiente_agendamiento', ghl_contact_id = 'ghl_123'
  where id = 'c0000000-0000-0000-0000-00000000000a';

-- AC 32: cita_confirmada exige respuesta del proveedor
select pg_temp.debe_fallar(
  $q$update app.contactos set estado = 'cita_confirmada' where id = 'c0000000-0000-0000-0000-00000000000a'$q$,
  'sin una cita confirmada por el proveedor');

insert into app.citas (id, tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor)
  values ('e0000000-0000-0000-0000-00000000000a', (select ta from ids), 'c0000000-0000-0000-0000-00000000000a',
          'd0000000-0000-0000-0000-00000000000a', 'lucia', '2026-10-10 15:00-05', 'America/Bogota', 'llamada', 'calendly');
update app.contactos set estado = 'seleccion_pendiente_confirmacion' where id = 'c0000000-0000-0000-0000-00000000000a';

select pg_temp.debe_fallar(
  $q$update app.citas set estado = 'confirmada' where id = 'e0000000-0000-0000-0000-00000000000a'$q$,
  'citas_check');  -- sin id_externo del proveedor

-- AC 35: no hay entrega antes de confirmar
select pg_temp.debe_fallar(
  format($q$insert into app.entregas_asesor (tenant_id, contacto_id, cita_id, asesor_id, resumen)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'r')$q$,
         (select ta from ids)),
  'está en estado seleccion_pendiente');

update app.citas set estado = 'confirmada', id_externo = 'cal_evt_1' where id = 'e0000000-0000-0000-0000-00000000000a';
update app.contactos set estado = 'cita_confirmada' where id = 'c0000000-0000-0000-0000-00000000000a';

-- AC 40: un reintento no duplica la cita
select pg_temp.debe_fallar(
  format($q$insert into app.citas (tenant_id, contacto_id, conversacion_id, rol_codigo, inicio, zona_horaria, modalidad, proveedor, id_externo, estado)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 'lucia', now(), 'America/Bogota', 'llamada', 'calendly', 'cal_evt_1', 'confirmada')$q$,
         (select ta from ids)),
  'duplicate key');

select pg_temp.debe_fallar(
  $q$update app.contactos set estado = 'entregado_asesor' where id = 'c0000000-0000-0000-0000-00000000000a'$q$,
  'sin una entrega registrada');

insert into app.entregas_asesor (tenant_id, contacto_id, cita_id, asesor_id, resumen)
  values ((select ta from ids), 'c0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-000000000001', 'Propietaria de apartamento en Chapinero');
update app.contactos set estado = 'entregado_asesor', asesor_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  where id = 'c0000000-0000-0000-0000-00000000000a';

-- AC 40: una sola entrega por cita
select pg_temp.debe_fallar(
  format($q$insert into app.entregas_asesor (tenant_id, contacto_id, cita_id, asesor_id, resumen)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'r')$q$,
         (select ta from ids)),
  'entregas_una_por_cita');

-- AC 42: entrega manual sin cita exige motivo
select pg_temp.debe_fallar(
  format($q$insert into app.entregas_asesor (tenant_id, contacto_id, asesor_id, resumen, es_excepcion)
            values (%L, 'c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'r', true)$q$,
         (select ta from ids)),
  'entregas_asesor_check');

do $$
begin
  if (select count(*) from app.historial_estados where contacto_id = 'c0000000-0000-0000-0000-00000000000a') <> 5 then
    raise exception 'historial_estados no registró las 5 transiciones';
  end if;
  raise notice 'OK máquina de estados, citas y entrega al asesor';
end $$;

-- RLS: un usuario solo ve su tenant -------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
begin
  if exists (select 1 from app.contactos where tenant_id = (select ta from ids)) then
    raise exception 'RLS: el usuario del tenant B ve contactos del tenant A';
  end if;
  if exists (select 1 from app.roles_agente) then
    raise exception 'RLS: el usuario del tenant B ve roles del tenant A';
  end if;
  if (select count(*) from app.contactos) <> 1 then
    raise exception 'RLS: el usuario del tenant B debería ver exactamente su contacto';
  end if;
end $$;

select pg_temp.debe_fallar(
  format($q$insert into app.plantillas (tenant_id, clave, texto) values (%L, 'x', 'y')$q$, (select ta from ids)),
  'row-level security');

update app.contactos set nombre = 'hackeado' where tenant_id = (select ta from ids);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$
begin
  if (select nombre from app.contactos where id = 'c0000000-0000-0000-0000-00000000000a') <> 'Ana' then
    raise exception 'RLS: el tenant B modificó un contacto del tenant A';
  end if;
  if (select count(*) from app.roles_agente) <> 2 then
    raise exception 'RLS: el admin del tenant A debería ver a Lucía y Sonia';
  end if;
  raise notice 'OK aislamiento RLS entre tenants (AC 02)';
end $$;
reset role;
