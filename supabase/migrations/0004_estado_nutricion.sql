-- =============================================================================
-- Estado "nutricion": cumple los criterios pero no tiene urgencia; no se
-- agenda y se nutre con información (dossier) hasta que quiera avanzar.
--
-- Va en su propia migración: un valor nuevo de un enum no puede usarse en la
-- misma transacción en que se agrega (lo usa 0005).
-- =============================================================================

alter type app.estado_contacto add value if not exists 'nutricion' after 'calificado_pendiente_agendamiento';
