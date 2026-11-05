# Plan de implementación — Fase 1

Control del proyecto contra la propuesta comercial (25 sep 2026): [tablero](https://claude.ai/artifact/Pf7paAoK1HWPZYLoM5uMGr).
Ruta de lanzamiento paso a paso (quién, dónde, cómo comprobar): [guía](https://claude.ai/artifact/Ddsx1NVGMCWySLBMZXndiX).

## Etapa 1 — Fundaciones ✅ (este commit)

- Esquema de Supabase multiempresa con RLS, máquina de estados y reglas de entrega.
- Motor de calificación determinista y configurable.
- Configuración del tenant Javier Núñez: roles Lucía y Sonia, campos, criterios y plantillas.
- Prompts de sistema y del clasificador de intención.
- Pruebas automáticas: evaluador (Node) y base de datos (Postgres real).

## Etapa 2 — Canal y conversación (n8n)

- ✅ Proyecto de Supabase (`joylroehptnhelxodhqi`): migraciones 0001 y 0002 y seed aplicados (7 oct 2026). El 27 oct 2026 quedaron aplicados hasta la 0017 con el seed vigente, y el flujo publicado en n8n (activo). Faltan secretos de Meta en Vault e identificadores reales de canales.
- 4 nov 2026: migración 0018 y seed aplicados en Supabase; flujo principal y reporte actualizados en n8n (con sus credenciales); flujo de recordatorio creado inactivo (falta credencial Gmail y destinatarios).
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
| Arriendo | 9 oct 2026 | ~~Lucía: vende u ofrece en arriendo~~ (reemplazado el 19 oct: Lucía solo venta). Sonia: compra o busca arriendo (campo `operacion`) |
| Lucía solo venta | 19 oct 2026 | Saludo "¿vender o comprar?". Quien solo quiere arrendar recibe `solo_venta` y no sigue (regla temprana `solo_venta`); si vende y pregunta por arriendo, lo conversa con Javier en la visita |
| Dossier para prioridad baja | 9 oct 2026 | Envío automático por WhatsApp cuando exista (`parametros.dossier`) |
| Reporte semanal de no calificados | 9 oct 2026 | Correo los lunes al administrador con motivo de descalificación y leads de prioridad baja |
| Presentación como asistente virtual | 9 oct 2026 | Se mantiene (AC 09) |
| Marca | 9 oct 2026 | "JNdelT Real Estate" (puede cambiar: `tenant.json` → `nombre`) |
| Asesores | 9 oct 2026 | Round Robin del calendario de GoHighLevel; al inicio solo Javier |
| Todo umbral es parámetro | 9 oct 2026 | `config/tenants/<tenant>/tenant.json` → `parametros` (ver [configuracion.md](configuracion.md)) |

| Validación de Javier | 17 oct 2026 | `entregables/Validacion_Lucia_Sonia_validado_2026-10-17.xlsx`: mensajes aprobados; horario 9:00 a. m. a 9:00 p. m.; tipos apartamento, casa, terreno, oficina; valor mínimo de venta 200.000.000 COP; ciudades y destinatarios del reporte en tablas (`app.ciudades_cobertura`, `app.usuarios`). Pendientes: video, borrador del acuerdo, dossier y marca de las plantillas de Meta |
| Cobertura por barrio desde hoja de Google | 19 oct 2026 | `app.barrios_cobertura` sincronizada cada 15 min por n8n. Ver [cobertura.md](cobertura.md). Desde el 26 oct Lucía la usa al calificar. Pendiente de la reunión: tono formal y Sonia inactiva |
| Conversación libre, decisiones fijas | 26 oct 2026 | Las plantillas son guías: el agente las redacta con sus palabras y el código rellena los datos exactos (horarios, fechas, comisión, enlaces). Solo las aprobadas por Meta (`requiere_aprobacion_meta`) van literales. Si la redacción no respeta los datos, se envía el texto literal. Ver [n8n.md](n8n.md#cómo-funciona-un-turno) |
| Guion de Lucía de Javier | 26 oct 2026 | `entregables/Guion_Lucia_Javier_2026-10-26.docx`: estado del inmueble, si está publicado, otros decisores, respuestas por plazo y valor, objeciones de precio y exclusividad, referencia por barrio y por valor. Ver decisiones D1 a D8 abajo |
| Revisión de plantillas de Meta | 26 oct 2026 | `entregables/Plantillas_Meta_JNdelT_revision_Javier_2026-10-26.xlsx` (cambios en rojo) aplicada en `entregables/Plantillas_Meta_JNdelT.xlsx`, columna "Revisión de Javier"; 4 plantillas nuevas del guion. Ninguna enviada a Meta |
| D1 Encuentro | 26 oct 2026 | Llamada telefónica (donde el guion dice "visita") |
| D2 Valor de la propiedad | 26 oct 2026 | Mínimo 450.000.000 COP; menos → referencia a un colega con autorización, no se archiva. Desde 1.000.000.000 COP, respuesta premium |
| D3 Opciones | 26 oct 2026 | Botones (hasta 3) o lista en WhatsApp; lista con emojis numerados en Instagram (`menu` en `roles/lucia.json`, horarios) |
| D4 Documentos | 26 oct 2026 | Solo se menciona en la confirmación tener a mano escritura, certificado de tradición y predial; no se piden ni se reciben por chat |
| D5 Prioridad B | 26 oct 2026 | ~~Se agenda a futuro~~ (reemplazada el 4 nov, ver "Prioridad B con recordatorio"): horarios desde `prioridad.baja_agendar_desde_dias` (14, provisional), con plazos de hasta `prioridad.baja_agendar_hasta_meses` (12, provisional); más allá, nutrición. También es B quien no da el valor tras dos intentos (`valor_no_informado`) |
| Horario de llamadas | 27 oct 2026 | ~~Lunes a viernes de 9:00 a. m. a 5:00 p. m.~~ Reemplazado el mismo día por el cronograma de Javier |
| Cronograma de Javier (nov 2026 – ene 2027) | 27 oct 2026 | `entregables/Cronograma_Javier_2026-10-22.docx`. Lucía sigue agendando llamadas, solo en los huecos que dejan las visitas y actividades, sábados incluidos (`agenda.ventanas_llamada`, `viernes_rotacion`, `excepciones`, `vacaciones`). Ver [configuracion.md](configuracion.md#agenda-de-llamadas-según-el-cronograma-de-javier-27-oct-2026) |
| D6 Permiso inicial | 26 oct 2026 | Lucía sigue pidiendo permiso antes de las preguntas |
| D7 Datos en blanco del guion | 26 oct 2026 | Parámetros en `null` hasta que Javier los entregue; mientras tanto el agente no los menciona (ver pendientes) |
| D8 Video | 26 oct 2026 | Con `comercial.propuesta.video_url`, la propuesta se envía con el video (`propuesta_video`); sin URL no se ofrece |
| Reunión con Javier y prompt maestro | 4 nov 2026 | Revisión de la reunión del 27 oct y del prompt de Javier del 29 oct (`Dapti Prompts Agente Original y Nuevo de Claude.docx`). Decisiones abajo |
| Agente híbrido | 4 nov 2026 | Se adopta la misión y el tono del prompt de Javier (`prompts/lucia.md`), pero las reglas de cobertura, valor, prioridad y agenda siguen en código. Reemplaza la idea de un agente con herramientas |
| Prioridad B con recordatorio | 4 nov 2026 | Alta: hasta 3 meses (se agenda). B: más de 3 meses o sin valor; no se agenda ni se ofrece llamada. Javier recibe un correo 2 meses antes de la fecha estimada de venta (`prioridad.recordatorio_meses_antes`, migración 0018, flujo de recordatorio). Reemplaza D5 |
| Tolerancia de valor | 4 nov 2026 | 10 % bajo el mínimo, siempre: se atiende desde 405 M (`propietarios.tolerancia_valor_pct`) |
| Ubicación primero | 4 nov 2026 | Orden: ciudad, barrio, tipo de inmueble, nombre completo… La dirección exacta sigue al final. Se mantienen la ciudad, el nombre completo y la relación con el inmueble |
| Llamada solo al calificar | 4 nov 2026 | Lucía no ofrece ni anticipa la llamada con Javier antes de tener horarios ni tras un rechazo, aunque la persona insista |
| Condiciones que dice Lucía | 4 nov 2026 | Solo el 5 % y el 2,5 % (como respuesta a objeciones). La duración de la exclusividad, la cláusula de salida y el informe mensual los explica Javier |
| Retraso de escritura | 4 nov 2026 | Pausa de 2 a 8 s según el largo del mensaje (`conversacion.retraso_escritura`) |
| Barrios no listados | 4 nov 2026 | Van en el reporte semanal, para revisar la hoja de cobertura |
| El encuentro sigue siendo llamada | 4 nov 2026 | Se mantiene D1 |

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
| Plantillas aprobadas por Meta | Etapa 2 | 14 en borrador en `entregables/Plantillas_Meta_JNdelT.xlsx`; en el sistema solo `pendiente_agenda` marcada como requerida. Faltan los envíos programados |
| Datos del guion de Javier (D7, D8) | Confirmar antes de activar el flujo | Desde el 4 nov Lucía solo dice el 5 % y el 2,5 % (si el propietario consigue al comprador durante la exclusividad); ver [configuracion.md](configuracion.md). Siguen sin usarse el seguimiento a los 2 días y las 72 h para conseguir colega. Video de 3 minutos: falta la URL |
| Ventanas de llamada del cronograma | Confirmar con Javier | Provisionales: martes 3:30–5:00 (él lo dejó para propuestas de mandato), sábado 11:00–12:30 y la tarde de colchón del viernes |
| Exclusividad propia: 90 + 90 días o 6 meses; si el 5 % es solo si hay venta y si incluye IVA | Confirmar con Javier | Lucía no menciona la duración (`plazo_exclusividad_meses = null`) |
| Para después (prompt de Javier, 29 oct) | Etapa siguiente | Exclusividad con otra inmobiliaria y su vencimiento; reglas de arriendo (vencimiento, visitas, entrega libre); precio que sube tras derivar; puntaje A/B/C; tabla de aliados por zona y valor; escalamiento a Javier |
| App de configuración de parámetros | Etapa siguiente | Los parámetros siguen en `tenant.json` |
| Avisos de Meta en vacaciones | Antes del 21 dic | Pausarlos del 21 dic al 3 ene o dejarlos activos con la agenda cerrada (decisión de Javier). El agente funciona igual en los dos casos |
| Referencia aceptada: ¿prometer contacto? | Aceptación | El guion dice "le paso tu información hoy mismo y se comunicará contigo"; el agente sigue sin prometer contacto hasta que haya colegas aliados confirmados |
| Dirección no verificable: ¿archivar o revisión manual? | Etapa 3 | Se marca no calificado con motivo `direccion_no_verificada` |
| Tiempos de conservación de datos | Antes de producción | Sin política de borrado |
| Teléfono obligatorio para contactos de Instagram | Etapa 2 | Obligatorio (se pregunta en DM) |
