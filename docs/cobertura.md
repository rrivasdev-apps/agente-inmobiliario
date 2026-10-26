# Cobertura por barrio

**Decisión (19 de octubre de 2026, reunión con Javier Núñez):** los propietarios se califican también por el barrio del inmueble. Los barrios atendidos salen de una hoja de Google que mantiene el equipo, no del código. Complementa `app.ciudades_cobertura` (0009): la ciudad dice si el inmueble está en el mercado; el barrio, si se atiende directamente o se refiere a un colega.

> Estado (26 oct 2026): la tabla y la sincronización están en producción. En el repositorio, Lucía ya usa el barrio para calificar (migración 0017 y regla `cobertura_barrio`); falta aplicarlo en Supabase y publicar el flujo.

## Al calificar

Con la ciudad atendida y el barrio dado, `app.contexto_conversacion` trae las filas activas de `app.barrios_cobertura` y `resolverBarrio` decide:

- **Atendido** (`Sí`): sigue la calificación.
- **No atendido** (`No`): regla temprana `cobertura_barrio`; Lucía envía `fuera_cobertura_barrio` y pide autorización para una posible referencia.
- **Desconocido, ambiguo o sin definir**: no descarta a nadie; queda una advertencia en `app.eventos` (`operacion = 'cobertura_barrio'`) para revisar la hoja.

## Cómo se actualiza

```
Hoja "Barrios cobertura — JNdelT" ──(n8n cada 15 min)──▶ app.sincronizar_barrios ──▶ app.barrios_cobertura
```

- Hoja: https://docs.google.com/spreadsheets/d/1KMHWZz4TyT9iEcCxHsv_JAEjMcCOwN5i6k1xyYgrxxU (id en `config/tenants/javier-nunez/tenant.json` → `hoja_barrios`). El flujo lee siempre la **primera pestaña** con la API de Sheets (rango `A:Z`), sin importar su nombre; los encabezados deben quedar en la fila 1.
- Flujo de n8n: **Agente inmobiliario: sincronizar barrios atendidos** (id `IoRRrBoydHaPnWxs`, `n8n/sincronizar-barrios.json`), activo. Credenciales: `Google Sheets account` y `Postgres account`.

Qué edita el equipo en la hoja:

- **"¿Lo atiendo? (Sí/No)"**: `Sí` se atiende; `No` se ofrece como referido; vacío = sin definir.
- **"Mis notas"**: notas libres; se guardan, no cambian la calificación.
- **"Alias"** (columna opcional al final): otros nombres del barrio separados por coma (p. ej. `Cedritos`).
- Agregar un barrio: una fila nueva con localidad, código de UPZ, UPZ y barrio. Borrar una fila **desactiva** el barrio (no se borra de la base).

Cada sincronización deja un registro en `app.eventos` (`operacion = 'sincronizar_barrios'`) con cuántos barrios se agregaron, cambiaron o desactivaron, y las advertencias de la hoja (nombres truncados, valores distintos de Sí/No, filas repetidas). Si nada cambió no toca filas.

### Protecciones

- Si la hoja llega vacía o con menos de la mitad de los barrios activos, `app.sincronizar_barrios` **cancela sin cambiar nada** y la ejecución de n8n queda en error.
- Un barrio con el mismo nombre en dos UPZ (Lisboa, Atenas, La Cabrera…) son dos filas; `resolverBarrio` (`src/cobertura/barrios.js`) solo lo da por resuelto si ambas tienen la misma marca o si la localidad/UPZ lo desambigua.
- El seed solo siembra `config/tenants/javier-nunez/barrios.csv` (la hoja del 19 oct: 447 barrios, 114 Sí, 333 No) si el tenant no tiene barrios; nunca pisa los cambios de la hoja.

## Datos a revisar en la hoja

- Cinco filas "Santa Bárbara [truncado] #n" (UPZ 14 y 16): nombre incompleto; no se reconocerán hasta corregirlas.
- Nombres "completados por inferencia (verificar)" según la columna de observaciones.
- La UPZ 21 Los Andes (Barrios Unidos) solo incluye La Castellana.
- El listado base es de 2016 aproximadamente; conviene contrastarlo con SDP / Catastro / IDECA.
- La hoja se creó desde el CSV: no tiene la pestaña de instrucciones, el resumen ni la lista desplegable Sí/No del Excel original.
