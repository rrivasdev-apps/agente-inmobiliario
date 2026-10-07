# GoHighLevel: CRM y calendario

**Decisión (7 de octubre de 2026):** el calendario de la Fase 1 es el **calendario nativo de GoHighLevel**.

Motivos: el contacto, su etiqueta y la cita quedan en la misma subcuenta, sin sincronizar identificadores con un sistema externo; el calendario asigna asesores (incluido round-robin); la API permite ofrecer horarios reales dentro del chat; y cada futuro tenant usa su propia subcuenta sin integraciones adicionales. El diseño mantiene el proveedor configurable por tenant (AC 31).

Código: `src/integraciones/gohighlevel.js` (pruebas en `tests/gohighlevel.test.js`). Endpoints verificados contra la [especificación OpenAPI oficial](https://github.com/GoHighLevel/highlevel-api-docs).

## Endpoints usados

| Paso | Endpoint | Cabecera `Version` | Permiso (scope) |
|---|---|---|---|
| Registrar contacto calificado | `POST /contacts/upsert` | `2021-07-28` | `contacts.write` |
| Consultar horarios libres | `GET /calendars/{calendarId}/free-slots` | `2021-04-15` | `calendars.readonly` |
| Reservar la cita | `POST /calendars/events/appointments` | `2021-04-15` | `calendars/events.write` |
| Conciliar tras un timeout | `GET /contacts/{contactId}/appointments` | `2021-07-28` | `contacts.readonly` |
| Leer una cita | `GET /calendars/events/appointments/{eventId}` | `2021-04-15` | `calendars/events.readonly` |

Base: `https://services.leadconnectorhq.com`.

## Reglas del PRD que garantiza el módulo

- **AC 26**: el upsert no envía `assignedTo`. Registrar no es asignar.
- **AC 30**: solo se reserva un horario que estaba en la lista ofrecida.
- **AC 32**: la cita es confirmada solo si GoHighLevel devuelve `id` y estado confirmado. Si el calendario exige confirmación manual (`new`), queda pendiente.
- **AC 39**: se envía `ignoreFreeSlotValidation: false`, así GoHighLevel rechaza un horario que se acaba de ocupar y el agente ofrece alternativas.
- **AC 40**: si la reserva no responde, antes de reintentar se consultan las citas del contacto y se reutiliza la existente.
- **AC 41**: los errores se clasifican (horario ocupado, credencial inválida, proveedor caído, solicitud rechazada); ninguno produce una confirmación.

## Configuración pendiente en la subcuenta de Javier Núñez

1. **Verificar el plan**: la subcuenta debe permitir *Private Integrations* (acceso a la API v2).
2. **Crear una Private Integration** (Settings → Private Integrations) con los scopes de la tabla anterior. Guardar el token **solo** como credencial de n8n (`ghl-javier-nunez`, tipo Header Auth: `Authorization: Bearer <token>`).
3. **Duplicados**: Settings → Business Profile → *Allow Duplicate Contact* desactivado, con prioridad **teléfono** y luego **correo** (AC 23). El upsert aplica esta configuración.
4. **Calendario**: crear un calendario para las citas con asesores.
   - Tipo *Round Robin* si las citas se reparten entre varios asesores; *Personal* si atiende uno solo.
   - Definir duración, horario de atención, antelación mínima y zona horaria `America/Bogota`.
   - Habilitar las modalidades (teléfono, Google Meet, presencial).
   - **No** exigir confirmación manual de la cita, o las citas quedarán en estado pendiente.
5. **Asesores**: cada asesor debe ser usuario de la subcuenta. Registrar su `ghl_user_id` en `app.asesores` para enlazar la asignación del calendario con la entrega.
6. **Etiquetas**: crear `agente-lucia`, `agente-sonia`, `canal-whatsapp`, `canal-instagram_dm`.
7. Enviar `location_id` y `calendar_id` para completar `config/tenants/javier-nunez/tenant.json`.

## Por validar en el entorno de pruebas

- El texto exacto del error de GoHighLevel cuando el horario ya fue tomado. El módulo lo detecta por patrón (`slot`, `not available`, `no longer available`); confirmar con una prueba real y ajustar si hace falta.
- Si el upsert **reemplaza** o **agrega** etiquetas en un contacto existente. Si las reemplaza, se debe leer el contacto antes y unir las etiquetas.
- Webhooks de citas (`AppointmentCreate`, `AppointmentUpdate`, `AppointmentDelete`) para reflejar reprogramaciones y cancelaciones hechas desde GoHighLevel.
