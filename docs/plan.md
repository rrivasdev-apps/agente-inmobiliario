# Plan de implementación — Fase 1

## Etapa 1 — Fundaciones ✅ (este commit)

- Esquema de Supabase multiempresa con RLS, máquina de estados y reglas de entrega.
- Motor de calificación determinista y configurable.
- Configuración del tenant Javier Núñez: roles Lucía y Sonia, campos, criterios y plantillas.
- Prompts de sistema y del clasificador de intención.
- Pruebas automáticas: evaluador (Node) y base de datos (Postgres real).

## Etapa 2 — Canal y conversación (n8n)

- ✅ Proyecto de Supabase (`joylroehptnhelxodhqi`): migraciones 0001 y 0002 y seed aplicados (7 oct 2026). Faltan secretos de Meta en Vault e identificadores reales de canales.
- ✅ Webhook de Meta (WhatsApp + Instagram DM + comentarios) con validación de firma.
- ✅ Resolución de tenant, idempotencia y registro de mensajes.
- ✅ Clasificador de intención, extracción de datos, evaluación y respuesta.
- ✅ Flujo en `n8n/`, generado desde `src/` ([n8n.md](n8n.md)). Creado inactivo en n8n; faltan credenciales y secretos.

## Etapa 3 — Verificación y CRM

- ✅ `verificar_direccion` con Google Maps (incluida en el flujo de la Etapa 2).
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
| Flujo determinista en lugar de agente con herramientas | 7 oct 2026 | El LLM clasifica, extrae y redacta; los pasos los ejecuta n8n. Ver [n8n.md](n8n.md) |
| Calificación mixta | 9 oct 2026 | Criterios mínimos y luego prioridad por plazo: alta se agenda; baja queda en `nutricion` y no se agenda |
| Arriendo | 9 oct 2026 | Lucía: vende u ofrece en arriendo. Sonia: compra o busca arriendo (campo `operacion`) |
| Dossier para prioridad baja | 9 oct 2026 | Envío automático por WhatsApp cuando exista (`parametros.dossier`) |
| Reporte semanal de no calificados | 9 oct 2026 | Correo los lunes al administrador con motivo de descalificación y leads de prioridad baja |
| Presentación como asistente virtual | 9 oct 2026 | Se mantiene (AC 09) |
| Marca | 9 oct 2026 | "JNdelT Real Estate" (puede cambiar: `tenant.json` → `nombre`) |
| Asesores | 9 oct 2026 | Round Robin del calendario de GoHighLevel; al inicio solo Javier |
| Todo umbral es parámetro | 9 oct 2026 | `config/tenants/<tenant>/tenant.json` → `parametros` (ver [configuracion.md](configuracion.md)) |

## Decisiones pendientes que bloquean etapas

| Decisión (PRD §10) | Bloquea | Valor provisional en el repo |
|---|---|---|
| Modalidades, duración, horarios, zona horaria | Etapa 4 | Zona `America/Bogota` |
| Facebook en Fase 1 | Etapa 2 | Tipo de canal creado, sin canal configurado |
| Relación válida con la propiedad | Aceptación | propietario, copropietario, apoderado |
| Ciudades y tipos de inmueble (`parametros.cobertura`) | Aceptación | Bogotá; todos los tipos salvo "otro" |
| Umbrales (`parametros.compra`, `arriendo`, `prioridad`) | Aceptación | Compra ≥ 200.000.000 COP; canon sin mínimo; prioridad alta ≤ 3 meses |
| Dossier y destinatarios del reporte | Nutrición / reporte | Sin configurar |
| Política de duplicados en GHL | Etapa 3 | Teléfono, luego correo |
| Etiquetas, etapas y campos en GHL | Etapa 3 | `agente-lucia`, `agente-sonia` |
| Plantillas aprobadas por Meta | Etapa 2 | `pendiente_agenda` marcada como requerida |
| Dirección no verificable: ¿archivar o revisión manual? | Etapa 3 | Se marca no calificado con motivo `direccion_no_verificada` |
| Tiempos de conservación de datos | Antes de producción | Sin política de borrado |
| Teléfono obligatorio para contactos de Instagram | Etapa 2 | Obligatorio (se pregunta en DM) |
