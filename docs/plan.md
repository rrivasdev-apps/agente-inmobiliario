# Plan de implementación — Fase 1

## Etapa 1 — Fundaciones ✅ (este commit)

- Esquema de Supabase multiempresa con RLS, máquina de estados y reglas de entrega.
- Motor de calificación determinista y configurable.
- Configuración del tenant Javier Núñez: roles Lucía y Sonia, campos, criterios y plantillas.
- Prompts de sistema y del clasificador de intención.
- Pruebas automáticas: evaluador (Node) y base de datos (Postgres real).

## Etapa 2 — Canal y conversación (n8n)

- Proyecto de Supabase y aplicación de la migración.
- Webhook de Meta (WhatsApp + Instagram DM + comentarios) con validación de firma.
- Resolución de tenant, idempotencia y registro de mensajes.
- Clasificador de intención y agente con `registrar_datos` y `evaluar_calificacion`.
- Exportar los flujos de n8n a `n8n/` en el repositorio.

## Etapa 3 — Verificación y CRM

- `verificar_direccion` con Google Maps.
- ✅ Solicitud de upsert de contactos en GoHighLevel (etiquetas, sin asignar asesor).
- Campos personalizados en GoHighLevel, cuando se aprueben.

## Etapa 4 — Agendamiento y entrega

- ✅ Módulo de calendario de GoHighLevel (disponibilidad, reserva, conciliación, errores).
- Configurar el calendario en la subcuenta (checklist en [gohighlevel.md](gohighlevel.md)).
- Reserva, confirmación por webhook, asignación y notificación al asesor.

## Etapa 5 — Aceptación

- Ejecutar las 15 pruebas mínimas del PRD §9.8 contra un número de prueba.
- Prueba de aislamiento con un segundo tenant (ya cubierta a nivel BD).

## Decisiones tomadas

| Decisión | Fecha | Detalle |
|---|---|---|
| Calendario: GoHighLevel nativo | 7 oct 2026 | Ver [gohighlevel.md](gohighlevel.md) |

## Decisiones pendientes que bloquean etapas

| Decisión (PRD §10) | Bloquea | Valor provisional en el repo |
|---|---|---|
| Modalidades, duración, horarios, zona horaria | Etapa 4 | Zona `America/Bogota` |
| Asignación y distribución de asesores | Etapa 4 | Round-robin del calendario de GoHighLevel (por confirmar) |
| Facebook en Fase 1 | Etapa 2 | Tipo de canal creado, sin canal configurado |
| Relación válida con la propiedad | Aceptación | propietario, copropietario, apoderado |
| Ciudades, zonas y tipos de inmueble | Aceptación | Bogotá; todos los tipos salvo "otro" |
| Umbrales de Sonia | Aceptación | ≥ 200.000.000 COP; ≤ 6 meses |
| Política de duplicados en GHL | Etapa 3 | Teléfono, luego correo |
| Etiquetas, etapas y campos en GHL | Etapa 3 | `agente-lucia`, `agente-sonia` |
| Plantillas aprobadas por Meta | Etapa 2 | `pendiente_agenda` marcada como requerida |
| Dirección no verificable: ¿archivar o revisión manual? | Etapa 3 | Se marca no calificado con motivo `direccion_no_verificada` |
| Tiempos de conservación de datos | Antes de producción | Sin política de borrado |
| Teléfono obligatorio para contactos de Instagram | Etapa 2 | Obligatorio (se pregunta en DM) |
