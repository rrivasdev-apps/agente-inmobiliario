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
| **GoHighLevel** | Contactos, etiquetas, estado comercial y calendario nativo (decisión del 7 oct 2026, ver [gohighlevel.md](gohighlevel.md)). |

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
        8. Extraer datos, verificar dirección (Lucía), evaluar y redactar la respuesta (abajo)
        9. Enviar respuesta por Meta y guardar en app.mensajes
       10. Ante cualquier falla de proveedor → app.eventos (nivel error) + respuesta segura (AC 46, 47)
```

## Pasos del turno en n8n

Detalle y configuración en [n8n.md](n8n.md). El LLM no llama herramientas: el flujo ejecuta cada paso y el LLM solo clasifica, extrae datos y redacta. Cada paso es una función de la BD (`supabase/migrations/0002_funciones_n8n.sql`) que recibe `tenant_id` y `conversacion_id` resueltos desde el canal, nunca desde el LLM.

| Paso | Roles | Qué hace |
|---|---|---|
| `app.registrar_datos` | ambos | Fusiona en `contactos.datos` lo que extrajo el LLM. Solo acepta claves y tipos definidos en `roles_agente.campos`. |
| `app.registrar_verificacion` | solo Lucía | Guarda el resultado de Google Maps en `app.verificaciones_direccion`. La BD rechaza la llamada desde Sonia (AC 20). |
| `evaluar.js` + `app.guardar_evaluacion` | ambos | Califica con los criterios del tenant, guarda en `app.evaluaciones_calificacion` y aplica la transición de estado. |
| `app.registrar_oferta` / `app.registrar_cita` | ambos | Upsert del contacto, horarios libres y reserva en GoHighLevel (`src/n8n/agenda.js` + `src/integraciones/gohighlevel.js`). Solo se reserva un horario ofrecido (AC 30). |

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

Si el contacto reserva desde el enlace de la página de reservas de GoHighLevel en lugar del chat, la confirmación llega por el **webhook de citas de GoHighLevel**, que sigue el mismo camino desde "cita confirmada".

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
