begin;
-- =============================================================================
-- Permisos del panel sobre ciudades y usuarios (26 nov 2026).
--
-- 0009 creó app.ciudades_cobertura y app.usuarios con políticas RLS para los
-- miembros del tenant, pero sin el grant base al rol authenticated (el grant de
-- 0001 solo cubrió las tablas que existían entonces). Sin él, el panel no puede
-- leer ni administrar las ciudades. Las políticas RLS siguen decidiendo qué filas
-- ve cada miembro y que solo los admins escriben.
-- =============================================================================

grant select, insert, update, delete on app.ciudades_cobertura, app.usuarios to authenticated;

commit;
