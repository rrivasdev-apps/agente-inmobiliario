# Flujo de n8n: canal y conversación (Etapa 2)

Archivo: [`n8n/agente-inmobiliario.json`](../n8n/agente-inmobiliario.json), **generado** por `npm run n8n` desde:

- `src/n8n/meta.js`: webhooks y envíos de WhatsApp e Instagram.
- `src/n8n/conversacion.js`: solicitudes a OpenAI y decisión de la respuesta.
- `src/n8n/geocodificacion.js`: clasificación del resultado de Google Maps.
- `src/calificacion/evaluar.js`: calificación determinista.
- `prompts/clasificador.md`.

No se edita en n8n: se cambia el código, se regenera y se publica (ver abajo). `npm run n8n:check` falla si el JSON no está al día.

Instancia: `https://rersn8n.app.n8n.cloud`, flujo **Agente inmobiliario: Meta (Lucía y Sonia)** (id `kIdhAu7QlHJ3IL3h`), creado **inactivo**.

## Cómo funciona un turno

```
POST /webhook/agente-inmobiliario/meta     (responde 200 de inmediato)
  1. Firma X-Hub-Signature-256 ─ se compara en Supabase (app.verificar_firma_meta)
  2. Normalizar: WhatsApp, Instagram DM y comentarios; ignora estados y ecos
  3. app.recibir_mensaje ─ canal → tenant, idempotencia, contacto, conversación
       comentario → plantilla comentario_instagram como respuesta y fin (AC 08)
  4. Sin rol → OpenAI clasifica → app.asignar_rol  (ambigua → plantilla seleccion_intencion)
  5. OpenAI extrae datos → app.registrar_datos (solo claves y tipos del rol)
  6. Lucía con dirección completa sin verificar → Google Maps → app.registrar_verificacion
  7. evaluar.js → app.guardar_evaluacion (auditoría + transición de estado)
  8. Respuesta: plantilla fija o redacción con OpenAI
       archivar → no_calificado · aclarar_direccion → direccion_ambigua
  8b. Calificado → agendamiento con GoHighLevel (src/n8n/agenda.js):
       sin horarios ofrecidos → upsert del contacto → horarios libres → app.registrar_oferta → plantilla calificado
       eligió un horario de la lista → crear cita → app.registrar_cita → plantilla confirmacion
       horario ocupado → nuevos horarios → plantilla horario_agotado · falla → falla_agenda (error_agendamiento)
  9. Envío por Graph API → app.registrar_respuesta (mensaje, AC 09, errores)
```

El LLM **no** llama herramientas ni decide la calificación: solo clasifica, extrae y redacta. Toda escritura pasa por las funciones de `supabase/migrations/0002_funciones_n8n.sql`, que reciben `tenant_id` y `conversacion_id` resueltos por la BD a partir del canal. Las cargas viajan en base64 para que ningún texto del usuario llegue como SQL.

Fallas de proveedor (AC 46, 47): OpenAI, Google Maps y Meta tienen "continuar ante error" y un reintento. Una falla queda en `app.eventos` y el turno sigue con una respuesta segura; nunca descarta al contacto.

## Configuración pendiente

### 1. Base de datos

✅ `0001_esquema_inicial.sql`, `0002_funciones_n8n.sql` y `seed.sql` ya están aplicados en el proyecto `joylroehptnhelxodhqi` (7 oct 2026). Una migración nueva se aplica con el endpoint de migraciones de la Management API o `supabase db push`, para que quede registrada en `supabase_migrations.schema_migrations`.

Secretos de Meta en Vault (SQL Editor de Supabase). Nunca salen de la BD:

```sql
select vault.create_secret('<App Secret de la app de Meta>', 'meta_app_secret');
select vault.create_secret('<token inventado para verificar el webhook>', 'meta_verify_token');
```

Identificadores reales de los canales (reemplazan los `PENDIENTE_*` del seed):

```sql
update app.canales set identificador_externo = '<phone_number_id de WhatsApp>'
  where identificador_externo = 'PENDIENTE_WHATSAPP_PHONE_NUMBER_ID';
update app.canales set identificador_externo = '<id de la cuenta de Instagram>'
  where identificador_externo = 'PENDIENTE_INSTAGRAM_ACCOUNT_ID';
```

Opcional: modelo de OpenAI (por defecto `gpt-4.1-mini`):

```sql
update app.integraciones set configuracion = jsonb_set(configuracion, '{modelo}', '"gpt-4.1-mini"')
  where categoria = 'llm';
```

### 2. Credenciales en n8n

Abrir el flujo y asignar en cada nodo (el nombre de la credencial aparece en la nota del nodo):

| Credencial | Tipo | Nodos |
|---|---|---|
| Supabase agente-inmobiliario | Postgres. Host del **Session pooler** (`aws-0-us-east-1.pooler.supabase.com`, puerto 5432, usuario `postgres.joylroehptnhelxodhqi`, SSL). La conexión directa es solo IPv6. | Todos los nodos Postgres |
| OpenAI | OpenAI API | `OpenAI: …` |
| Google Maps | Query Auth, nombre `key` | `Google Maps: geocodificar` |
| Meta WhatsApp | Header Auth, `Authorization: Bearer <token de usuario del sistema>` | `WhatsApp: enviar` |
| Meta Instagram | Header Auth, `Authorization: Bearer <token de la página vinculada>` | `Instagram: enviar`, `Instagram: responder comentario` |

### 3. Webhook en Meta

En la app de Meta (WhatsApp → Configuración y Instagram → Webhooks):

- URL de devolución: `https://rersn8n.app.n8n.cloud/webhook/agente-inmobiliario/meta`
- Token de verificación: el valor de `meta_verify_token`.
- Campos: WhatsApp `messages`; Instagram `messages` y `comments`.

Activar el flujo **antes** de verificar el webhook (n8n solo atiende la URL de producción con el flujo activo).

## Reporte semanal de no calificados

Flujo **Agente inmobiliario: reporte semanal de no calificados** (id `rqPgSXmlwJvlb5yA`, `n8n/reporte-no-calificados.json`), creado **inactivo**. Los lunes a las 7:50 (hora de Bogotá) consulta `app.reportes_no_calificados()` y envía por Gmail, a `parametros.reporte_no_calificados.destinatarios` de cada tenant, dos tablas de los últimos `dias`:

- **No calificados**, con el motivo de descalificación.
- **Prioridad baja** (en nutrición, no se agendaron), con el plazo y el estado actual.

Para activarlo: asignar una credencial Gmail (OAuth2) al nodo **Enviar reporte**, poner el correo del administrador en los parámetros y activar el flujo. El nodo **Ejecutar ahora** permite probarlo a mano.

## Publicar cambios

```bash
npm run seed           # regenera supabase/seed.sql (idempotente: se puede aplicar sobre la BD con datos)
npm run n8n            # regenera los flujos de n8n/
npm test && npm run test:db
```

- Configuración: aplicar `supabase/seed.sql` en Supabase (upserts; no duplica).
- Flujos: `PUT /api/v1/workflows/<id>` con el JSON. Un PUT reemplaza los nodos: copiar las credenciales del flujo publicado a los nodos del JSON antes de enviarlo.

## Límites conocidos

- Un solo juego de credenciales de Meta por flujo: para un segundo tenant con otra cuenta de Meta hay que guardar los tokens por tenant (Vault) y leerlos en el envío.
- Mensajes que llegan casi al mismo tiempo del mismo contacto se procesan en paralelo; la BD evita duplicados, pero el orden de las respuestas no está garantizado.
- La ventana de 24 h de WhatsApp (AC 45) no se revisa: el flujo solo responde a mensajes entrantes, que siempre están dentro de la ventana.
- Entrega y notificación al asesor (Etapa 4) no están conectadas: la cita confirmada queda enlazada al asesor si su `ghl_user_id` está en `app.asesores`, pero no se registra `entregas_asesor` ni se notifica.
- Si la reserva no responde (timeout), se marca `error_agendamiento`; aún no se concilia con `GET /contacts/{id}/appointments` antes de reintentar (AC 40).
- Las reservas hechas desde el enlace de GoHighLevel y los cambios hechos en GoHighLevel no llegan al flujo (falta el webhook de citas).
