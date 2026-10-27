# Parámetros de configuración por tenant

Todo umbral de negocio vive en `config/tenants/<tenant>/tenant.json` → `parametros`. `npm run seed` lo copia a `app.tenants.parametros`, y el evaluador lo lee en cada turno. Cambiar un valor no requiere tocar código: editar, regenerar el seed y aplicarlo.

| Parámetro | Valor actual | Efecto |
|---|---|---|
| `cobertura.ciudades` | `["Bogotá"]` | Solo siembra la tabla `app.ciudades_cobertura` la primera vez. Las ciudades atendidas se administran en esa tabla (ver abajo). |
| `cobertura.tipos_inmueble` | apartamento, casa, terreno, oficina | Tipos atendidos (venta, compra y arriendo). Terreno incluye lote. |
| `propietarios.relaciones_validas` | propietario, copropietario, apoderado | Relación con el inmueble que califica (Lucía). |
| `propietarios.valor_minimo_cop` | `450000000` | Valor mínimo de la propiedad en venta (Lucía, 26 oct). Se aplica apenas la persona da el valor; por debajo se ofrece una referencia a un colega (`referencia_valor`). `null` = sin mínimo. |
| `propietarios.valor_premium_cop` | `1000000000` | Desde este valor Lucía responde con el mensaje premium del guion de Javier. Solo cambia la respuesta, no la calificación. |
| `prioridad.alta_hasta_meses` | `3` | Quien califica y quiere concretar en ese plazo o menos es prioridad alta (se agenda ya). Más: prioridad baja. |
| `prioridad.baja_agendar_desde_dias` | `14` (provisional) | Prioridad B = agendar a futuro: los horarios se ofrecen a partir de estos días (`calificado_futuro`). `null` = la prioridad baja se nutre sin cita (`nutricion`), como antes. Solo lo usan los roles con `agenda_baja_parametro` (Lucía). |
| `prioridad.baja_agendar_hasta_meses` | `12` (provisional) | Tope de la prioridad B: con un plazo mayor (p. ej. "en 2 años") la prioridad baja se nutre sin cita. "Más de 6 meses" y "aún no lo tengo definido" se registran como 12, así que se agendan. `null` = toda la prioridad baja se agenda a futuro. |
| `compra.presupuesto_minimo_cop` | `200000000` | Presupuesto mínimo para compradores. `null` = sin mínimo. |
| `arriendo.canon_minimo_cop` | `null` | Canon mensual mínimo para quien busca arriendo. `null` = sin mínimo. |
| `dossier.lucia` / `dossier.sonia` | `null` | `{ "url": "https://…/dossier.pdf", "nombre_archivo": "JNdelT.pdf" }`: se envía automáticamente a prioridad baja (archivo en WhatsApp, enlace en Instagram). La URL debe ser pública. |
| `nutricion.incluir_no_calificados` | `true` | Los no calificados reciben la plantilla `no_calificado_nutricion` (y el dossier, si existe) en lugar de solo "no cumples las condiciones". |
| `conversacion.cierre_inactividad_horas` | `48` | Horas sin mensajes tras las que se cierra la conversación. Si la persona escribe después, el agente la saluda por su nombre, le recuerda lo pendiente (cita, agendamiento, datos) y pregunta en qué la puede ayudar. |
| `comercial.asesor_nombre_completo` | `"Javier Núñez del Toro"` | A nombre de quién se presentan Lucía y Sonia ("asistente virtual de Javier Núñez del Toro"). |
| `comercial.propuesta.exclusiva` / `comision_pct` / `comision_solo_si_vende` | `true` / `5` / `true` | Lo que Lucía explica antes de agendar: exclusiva, comisión del 5 % que solo se paga si se concreta la venta. |
| `comercial.propuesta.comision_comprador_propio_pct` | `2.5` (provisional) | Comisión si el propietario consigue al comprador. Lucía la usa solo para responder dudas. `null` = no se menciona. |
| `comercial.propuesta.comision_comprador_propio_condicion` | "si el propietario consigue por su cuenta al comprador durante la exclusividad" (provisional) | Condición de esa comisión, tal como la dice Lucía. |
| `comercial.propuesta.plazo_exclusividad_meses` | `6` (provisional) | Duración de la exclusividad. `null` = Lucía dice que lo aclara Javier. |
| `comercial.propuesta.clausula_salida` | "se revisan juntos los resultados y el propietario decide si continúa, se ajusta la estrategia o se termina el acuerdo" (provisional) | Qué pasa al final del plazo. `null` = lo aclara Javier. |
| `comercial.propuesta.informe_mensual` | `true` (provisional) | Si se entrega un informe mensual de la gestión. `null` o `false` = no se menciona. |
| `comercial.propuesta.video_url` / `video_minutos` | `null` / `3` | Con URL, la propuesta se envía con el video (`propuesta_video`) y menciona los minutos; sin URL no se ofrece. |
| `comercial.propuesta.beneficios` / `acuerdo_url` | `[]` / `null` | Beneficios aprobados y borrador del acuerdo; vacíos, no se mencionan. |
| `seguimiento.dias_tras_pensarlo` | `2` (provisional) | Días para escribir tras "déjame pensarlo". Aún no se usa: Lucía no lo promete hasta que existan los envíos programados. |
| `seguimiento.horas_para_aliado` | `72` (provisional) | Plazo para conseguir un colega aliado antes de avisarle a la persona. Aún no se usa, por la misma razón. |
| `agenda.hora_minima` / `agenda.hora_maxima` | `"09:00"` / `"17:00"` | Horario de llamadas (hora de Bogotá, 27 oct 2026), además de la disponibilidad del calendario. El encuentro debe terminar a la hora de cierre (si no hay duración configurada, debe empezar antes). |
| `agenda.dias_semana` | lunes a sábado | Respaldo: solo se usa si no hay `ventanas_llamada`. Días en que se ofrecen llamadas (`lunes` … `domingo`, sin tildes). Sin el parámetro, todos los días. |
| `agenda.ventanas_llamada` | ver abajo (provisional) | Ventanas de llamada de cada día según el cronograma de Javier, fuera de las visitas: `{ "lunes": [["09:00", "12:30"]], ... }`. Un día que no aparece no tiene llamadas. Cuando existe, reemplaza `hora_minima`, `hora_maxima` y `dias_semana`. |
| `agenda.viernes_rotacion` | 1.º sin llamadas; 2.º a 5.º de 13:30 a 17:00 (provisional) | Ventanas del viernes según su número en el mes (1.º contenido, 2.º valoraciones extra, 3.º relacional, 4.º revisión). Gana sobre `ventanas_llamada.viernes`. |
| `agenda.excepciones` | festivos y traslados de nov 2026 a ene 2027 | `[{ "fecha": "AAAA-MM-DD", "ventanas": [], "motivo": "..." }]`: ventanas de ese día; `[]` = sin llamadas. Gana sobre todo lo anterior salvo las vacaciones. |
| `agenda.vacaciones` | 23 dic 2026 – 11 ene 2027 | `{ "desde", "hasta", "retorno_texto" }`: sin llamadas en esas fechas; durante las vacaciones los horarios se buscan desde el día siguiente a `hasta` y se ofrecen con la plantilla `calificado_vacaciones`. |
| `agenda.franjas` | mañana 09:00–12:00, tarde 12:00–17:00 | Qué significa "en la mañana" o "en la tarde" cuando la persona pide otro horario. Claves: `manana`, `tarde`, `noche`. |
| `agenda.encuentros` | llamada, videollamada, presencial | Cómo se nombra cada modalidad en la confirmación y quién contacta a quién. **Por validar con Javier.** |
| `comercial.asesor` | `"Javier"` | Nombre con el que el agente se refiere al asesor en las objeciones ("eso lo revisa Javier en la reunión"). |
| `comercial.argumento_exclusividad` | texto | Instrucción para responder "ya tengo agencia o asesor". |
| `reporte_no_calificados.activo` | `true` | Incluye al tenant en el reporte semanal. |
| `reporte_no_calificados.dias` | `7` | Periodo que cubre cada reporte. |
| `reporte_no_calificados.destinatarios` | `[]` | Correos adicionales. Los destinatarios se administran en la tabla `app.usuarios` (ver abajo). |

Las reglas de cada rol (`roles/*.json` → `criterios`) usan estos parámetros con `"parametro": "ruta.en.parametros"`, y pueden aplicar solo a una operación con `"si": { "campo": "operacion", "valor": "arriendo" }`. El seed falla si una regla apunta a un parámetro que no existe.

## Calificación

1. **Datos obligatorios**: si falta alguno, se pide (los de compra o arriendo según `operacion`).
2. **Dirección** (solo Lucía): verificada con Google Maps.
3. **Criterios mínimos**: todas las reglas del rol. Si alguna falla: `no_calificado` con motivo.
4. **Prioridad**: plazo ≤ `prioridad.alta_hasta_meses` → alta → horarios y cita en GoHighLevel. Si no → baja: con `prioridad.baja_agendar_desde_dias` (Lucía) se agenda a partir de esos días, salvo que el plazo supere `prioridad.baja_agendar_hasta_meses`; sin él (Sonia), plantilla `prioridad_baja` (+ dossier si existe), estado `nutricion`, sin cita. Si la persona vuelve con urgencia, pasa a agendar.

Condiciones de los criterios: `si` aplica una regla o campo solo con cierto valor de otro dato; `salvo`, al revés (el valor de la propiedad no se exige ni se evalúa con `valor_no_informado`). `prioridad.baja_si` fuerza prioridad baja.

## Agenda de llamadas según el cronograma de Javier (27 oct 2026)

Fuente: `entregables/Cronograma_Javier_2026-10-22.docx`. Lucía agenda **llamadas** en los huecos que dejan las visitas de valoración y las demás actividades; las visitas las maneja Javier.

| Día | Llamadas (provisional) | Ocupado en el cronograma |
|---|---|---|
| Lunes | 9:00–12:30 | Tarde: visitas en Usaquén |
| Martes | 3:30–5:00 p. m. | Visitas en Chapinero y Barrios Unidos |
| Miércoles | 9:00–10:00 | Visitas en Suba; tarde: ventaneros |
| Jueves | 1:30–5:00 p. m. | Mañana: visitas en Usaquén |
| Viernes | según `viernes_rotacion` | Mañana: contenido, valoraciones extra, relacional o revisión |
| Sábado | 11:00–12:30 | Valoraciones 9:00 y 10:00; tarde: mostrar propiedades |

El orden con que se decide cada fecha: vacaciones → excepción de la fecha → viernes según su número → ventana semanal. La llamada debe terminar dentro de la ventana (con `duracion_minutos` del calendario).

**Mes a mes:** cuando Javier envíe el cronograma siguiente, se agregan sus festivos y traslados a `agenda.excepciones` (en Supabase, `app.tenants.parametros`, o en `tenant.json` y el seed). Las fechas pasadas pueden quedarse: no afectan.

## Mensajes: guía y datos exactos (26 oct 2026)

Las plantillas de `plantillas.json` son guías de sentido: el agente las redacta con sus palabras en cada conversación. Los datos entre `{{ }}` que deben ser exactos (horarios, fecha, hora, zona, modalidad, comisión, enlaces) los rellena el código después; si la redacción los cambia, los repite o agrega cifras, se envía el texto literal. Las plantillas con `"requiere_aprobacion_meta": true` se envían literales.

Las preguntas de los campos con `menu` (estado del inmueble, publicado, plazo) y los horarios se envían con opciones: botones o lista en WhatsApp, emojis numerados en Instagram.

## Estilo, nombre y objeciones

Las reglas de estilo y las objeciones están en `prompts/comun.md`, con `{{asesor}}` y `{{argumento_exclusividad}}` tomados de `parametros.comercial`.

El nombre del perfil de WhatsApp se usa solo si parece el nombre de una persona (sin números, sin términos genéricos como "Cliente" o "Ventas", no solo iniciales); el agente se dirige por el primer nombre y omite tratamientos como "Dr." o "Sra.". Si no es válido, el agente pregunta el nombre.

## Conversaciones y retorno

Una conversación se cierra tras `conversacion.cierre_inactividad_horas` sin mensajes: cada hora (pg_cron en Supabase) y, en todo caso, al llegar el siguiente mensaje. Ese mensaje abre una conversación nueva que conserva el rol (Lucía o Sonia), los datos del contacto, su cita y la verificación de la dirección.

En ese primer turno el agente no usa plantillas ni ofrece horarios: saluda por el primer nombre, recuerda en pocas palabras lo pendiente y pregunta en qué puede ayudar. Lo pendiente lo calcula el sistema según el estado: cita futura (fecha y hora), agendamiento pendiente, nutrición (plazo que dio) o datos incompletos. A un no calificado no se le recuerda nada. Desde el turno siguiente la conversación sigue su curso normal.

Un no calificado que corrige un dato (por ejemplo, ofrece otro inmueble dentro de la cobertura) se vuelve a evaluar.

## Varias propiedades de una misma persona

Cada propiedad (o búsqueda) es una **oportunidad** con sus propios datos, estado y cita (`app.oportunidades`). El contacto guarda el caso actual; los anteriores quedan guardados con su estado final.

- **Caso aparte (por defecto):** si la persona habla de otra propiedad, el caso actual se guarda y la calificación empieza de nuevo para la nueva, conservando nombre, teléfono y correo. Puede terminar en su propia cita.
- **En la misma reunión:** si la persona pide explícitamente revisarla en la reunión que ya tiene agendada, la nueva propiedad se califica igual pero no se ofrecen horarios. Al calificar queda con esa reunión, el agente lo confirma y se deja una nota para el asesor en la ficha del contacto en GoHighLevel con los datos de la propiedad.

El extractor de datos decide cuándo es otra propiedad y cuándo pide la misma reunión. Corregir un dato de la misma propiedad no abre un caso nuevo.

## Conversación de Lucía (revisión del 16 oct 2026)

1. **Bienvenida:** saluda, agradece, se presenta como asistente virtual de Javier Núñez del Toro y pide permiso para unas preguntas breves (`acepta_preguntas`). Si la persona no tiene tiempo, lo respeta y ofrece retomar.
2. **Orden de los datos:** ciudad primero, luego nombre completo (si solo da el primer nombre, lo pide completo), operación, tipo de inmueble, barrio, estado del inmueble (y vencimiento del arriendo o disponibilidad para visitas, según el caso), si ya está publicado, plazo, valor, relación con el inmueble, otros decisores y la dirección al final (guion de Javier, 26 oct). No pide el correo.
3. **Cobertura temprana:** las reglas marcadas `"temprana": true` (ciudad, barrio, valor y tipo de inmueble) se aplican apenas se conoce su dato. Fuera de la ciudad, en un barrio que no se atiende o con un valor menor al mínimo no se sigue calificando: se envía `fuera_cobertura`, `fuera_cobertura_barrio` o `referencia_valor`, se pide autorización para una posible referencia (`autoriza_referencia`) y no se promete ningún contacto. El reporte semanal muestra la autorización como "Autorizada (pendiente)".
4. **Propuesta antes de agendar:** quien califica con prioridad alta primero escucha cómo trabaja Javier (`comercial.propuesta`) y se le pregunta si tiene dudas. Los horarios se ofrecen solo cuando dice que quiere continuar (`desea_continuar`). Las dudas (`dudas_propuesta`) y la solicitud del borrador del acuerdo (`solicita_acuerdo`) quedan registradas y van en la descripción de la cita.
5. **Agenda:** solo horarios de `agenda.dias_semana`, entre `agenda.hora_minima` y `agenda.hora_maxima`. La confirmación indica fecha, hora de Colombia, modalidad y quién contacta a quién. La cita lleva para Javier el origen, la prioridad y los datos del caso.
6. **Cambio de asistente:** si quien habla con Lucía quiere comprar (o con Sonia quiere vender), pasa a la otra en un caso nuevo, con la misma ficha de contacto.

## Tablas de configuración (validación del 17 oct 2026)

Se editan en Supabase → Table Editor (esquema `app`) o con SQL. No requieren tocar código ni regenerar nada.

**Ciudades atendidas directamente** (`app.ciudades_cobertura`): cada fila es una ciudad; `activa = false` la deja de atender sin borrarla. Se compara sin distinguir mayúsculas ni tildes.

```sql
insert into app.ciudades_cobertura (tenant_id, ciudad)
select id, 'Chía' from app.tenants where slug = 'javier-nunez';
update app.ciudades_cobertura set activa = false where ciudad = 'Chía';
```

**Usuarios** (`app.usuarios`): nombre, correo y cargo. Quienes tienen `recibe_reporte = true` y están activos reciben el reporte semanal de los lunes.

```sql
insert into app.usuarios (tenant_id, nombre, email, cargo, recibe_reporte)
select id, 'Javier Núñez del Toro', '<correo>', 'Director', true from app.tenants where slug = 'javier-nunez';
```

Para desactivar una ciudad conviene `activa = false` en lugar de borrarla: el seed vuelve a sembrar las ciudades de `cobertura.ciudades` que no existan.
