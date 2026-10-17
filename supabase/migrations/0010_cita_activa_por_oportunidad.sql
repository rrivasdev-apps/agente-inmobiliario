-- =============================================================================
-- Una cita activa por oportunidad, no por contacto.
--
-- Desde 0007 cada propiedad (o búsqueda) es una oportunidad con su propia
-- cita. El índice original (una cita activa por contacto) impedía agendar la
-- segunda propiedad del mismo dueño: GoHighLevel creaba la cita y
-- app.registrar_cita fallaba al guardarla.
-- =============================================================================

drop index if exists app.citas_una_activa_por_contacto;

create unique index citas_una_activa_por_oportunidad
  on app.citas (tenant_id, oportunidad_id)
  where estado in ('seleccion_pendiente', 'confirmada', 'reprogramada');
