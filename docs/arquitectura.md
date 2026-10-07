# Arquitectura — Fase 1

Fuente: PRD v2 (7 de octubre de 2026).

## Componentes

| Componente | Responsabilidad |
|---|---|
| **Meta** (WhatsApp Cloud API, Instagram) | Entrada y salida de mensajes. |
| **n8n** | Orquestación: webhooks, llamadas al LLM, herramientas, integraciones. Un único flujo para todos los tenants (AC 04). |
| **OpenAI** | Clasificar intención y conducir la conversación. Extrae datos; **no decide** la calificación. |
| **Supabase** | Fuente de verdad de datos y configuración por tenant (§8.2). |
| **Google Maps** (Geocoding) | Verificar que la dirección de Lucía es una ubicación real. |
| **GoHighLevel** | Contactos, etiquetas, estado comercial y, si se elige, calendario. |
| **Calendario** | GoHighLevel, Calendly o Google Calendar, según el tenant (pendiente de decisión). |

## Flujo de un mensaje entrante

```
Meta webhook
  └─▶ [n8n] 1. Validar firma (X-Hub-Signature-256) y responder 200 de inmediato
        2. Resolver tenant y canal:  app.canales (tipo, identificador_externo)
        3. Idempotencia: insertar en app.mensajes con id_externo (si ya existe, terminar)
        4. Si es comentario de Instagram → responder plantilla comentario_instagram y terminar (AC 08)
        5. Buscar/crear contacto y conversación abierta
        6. Si la conversación no tiene rol → clasificador (prompts/clasificador.md)
             vender → lucia · comprar → sonia · ambigua → plantilla seleccion_intencion (AC 07)
        7. Cargar roles_agente del tenant (prompt, campos, criterios)  (AC 03)
        8. Agente LLM con herramientas (abajo) hasta producir la respuesta
        9. Enviar respuesta por Meta y guardar en app.mensajes
       10. Ante cualquier falla de proveedor → app.eventos (nivel error) + respuesta segura (AC 46, 47)
```

## Herramientas del agente

Cada herramienta es un sub-flujo de n8n que recibe siempre `tenant_id`, `contacto_id` y `conversacion_id` desde el contexto del flujo, nunca desde el LLM. El LLM no puede elegir de qué tenant lee o escribe.

| Herramienta | Roles | Qué hace |
|---|---|---|
| `registrar_datos` | ambos | Fusiona campos en `contactos.datos`. Solo acepta claves definidas en `roles_agente.campos`. |
| `verificar_direccion` | solo Lucía | Geocoding de Google Maps → `app.verificaciones_direccion`. La BD rechaza la llamada desde Sonia (AC 20). |
| `evaluar_calificacion` | ambos | Ejecuta `src/calificacion/evaluar.js` con los criterios del tenant → `app.evaluaciones_calificacion`. Aplica la transición de estado. |
| `consultar_disponibilidad` | ambos | Consulta el proveedor de calendario activo del tenant. Devuelve solo horarios reales (AC 30). |
| `reservar_cita` | ambos | Reserva en el proveedor. Solo con respuesta exitosa marca la cita `confirmada` (AC 32). |

### Criterio para clasificar una dirección (Google Maps Geocoding)

- `verificada`: un resultado con `location_type` `ROOFTOP` o `RANGE_INTERPOLATED`, sin `partial_match`, dentro de la ciudad declarada.
- `ambigua`: varios resultados, `partial_match`, o solo precisión `GEOMETRIC_CENTER` / `APPROXIMATE`.
- `no_verificada`: `ZERO_RESULTS` tras al menos una aclaración.
- `error`: cualquier otra respuesta o falla de red (no descarta al contacto).

## Secuencia posterior a la calificación

```
evaluar_calificacion = calificado
  ├─▶ upsert contacto en GoHighLevel (subcuenta del tenant, deduplicado por teléfono/correo)   AC 22, 23
  │     etiqueta agente-lucia / agente-sonia + canal de origen; guardar ghl_contact_id          AC 24, 25
  ├─▶ estado: calificado_pendiente_agendamiento   (NO se asigna asesor)                         AC 26, 28
  ├─▶ consultar_disponibilidad → plantilla `calificado` con horarios / `enlace_agenda`
  ├─▶ reservar_cita
  │     ok        → cita confirmada → estado cita_confirmada → plantilla `confirmacion`          AC 32, 37
  │     agotado   → plantilla `horario_agotado`                                                   AC 39
  │     falla     → estado error_agendamiento + app.eventos → plantilla `falla_agenda`           AC 41
  └─▶ con cita confirmada: elegir asesor → app.entregas_asesor → notificar → entregado_asesor     AC 35, 36
```

Para reservas por enlace (Calendly / página de reserva) la confirmación llega por **webhook del proveedor**, que sigue el mismo camino desde "cita confirmada".

## Garantías aplicadas en la base de datos

Estas reglas no dependen de que el flujo de n8n esté bien construido; la BD las rechaza:

- Claves compuestas `(tenant_id, id)` en todas las relaciones: no se pueden mezclar tenants (AC 01, 02).
- RLS por membresía para usuarios del panel (AC 02).
- Máquina de estados (`app.transiciones_estado`) con historial automático (AC 11).
- `cita_confirmada` exige una cita con `id_externo` del proveedor (AC 32).
- `entregado_asesor` exige una entrega, y la entrega exige cita confirmada o excepción con motivo (AC 35, 42).
- Índices únicos contra duplicados de mensajes, citas y entregas en reintentos (AC 40).
- `no_calificado` / `archivado` exigen motivo (AC 43).
- Solo conversaciones de Lucía pueden registrar verificaciones de dirección (AC 20).

## Seguridad de credenciales

`app.integraciones` guarda solo configuración no secreta (ids de subcuenta, calendario) y una **referencia** a la credencial (nombre de credencial en n8n o id de Supabase Vault). Las claves nunca se guardan en texto plano en tablas de negocio.

n8n se conecta con `service_role`, que omite RLS; por eso todas sus consultas deben filtrar por el `tenant_id` resuelto en el paso 2.
