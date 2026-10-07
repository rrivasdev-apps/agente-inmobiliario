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
       ofrecer_agenda → falla_agenda + evento "agendamiento" (Etapa 4 pendiente)
  9. Envío por Graph API → app.registrar_respuesta (mensaje, AC 09, errores)
```

El LLM **no** llama herramientas ni decide la calificación: solo clasifica, extrae y redacta. Toda escritura pasa por las funciones de `supabase/migrations/0002_funciones_n8n.sql`, que reciben `tenant_id` y `conversacion_id` resueltos por la BD a partir del canal. Las cargas viajan en base64 para que ningún texto del usuario llegue como SQL.

Fallas de proveedor (AC 46, 47): OpenAI, Google Maps y Meta tienen "continuar ante error" y un reintento. Una falla queda en `app.eventos` y el turno sigue con una respuesta segura; nunca descarta al contacto.

## Configuración pendiente

### 1. Base de datos

Aplicar `0001_esquema_inicial.sql`, `0002_funciones_n8n.sql` y `seed.sql` en el proyecto `joylroehptnhelxodhqi`.

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

## Publicar cambios

```bash
npm run n8n            # regenera n8n/agente-inmobiliario.json
npm test               # incluye pruebas de los nodos Code generados
curl -X PUT "https://rersn8n.app.n8n.cloud/api/v1/workflows/kIdhAu7QlHJ3IL3h" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
  -d @n8n/agente-inmobiliario.json
```

Un PUT reemplaza los nodos: hay que volver a asignar las credenciales que no estén en el JSON.

## Límites conocidos

- Un solo juego de credenciales de Meta por flujo: para un segundo tenant con otra cuenta de Meta hay que guardar los tokens por tenant (Vault) y leerlos en el envío.
- Mensajes que llegan casi al mismo tiempo del mismo contacto se procesan en paralelo; la BD evita duplicados, pero el orden de las respuestas no está garantizado.
- La ventana de 24 h de WhatsApp (AC 45) no se revisa: el flujo solo responde a mensajes entrantes, que siempre están dentro de la ventana.
- Agendamiento, GoHighLevel y entrega al asesor (Etapas 3 y 4) no están conectados: un contacto calificado recibe `falla_agenda` y queda un evento `agendamiento` para agendar manualmente.
