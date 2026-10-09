# Parámetros de configuración por tenant

Todo umbral de negocio vive en `config/tenants/<tenant>/tenant.json` → `parametros`. `npm run seed` lo copia a `app.tenants.parametros`, y el evaluador lo lee en cada turno. Cambiar un valor no requiere tocar código: editar, regenerar el seed y aplicarlo.

| Parámetro | Valor actual | Efecto |
|---|---|---|
| `cobertura.ciudades` | `["Bogotá"]` | Ciudades atendidas, para venta, compra y arriendo. Fuera de ellas: no califica. |
| `cobertura.tipos_inmueble` | apartamento, casa, lote, local, oficina, bodega | Tipos atendidos. |
| `prioridad.alta_hasta_meses` | `3` | Quien califica y quiere concretar en ese plazo o menos es prioridad alta (se agenda). Más: prioridad baja (`nutricion`, no se agenda). |
| `compra.presupuesto_minimo_cop` | `200000000` | Presupuesto mínimo para compradores. `null` = sin mínimo. |
| `arriendo.canon_minimo_cop` | `null` | Canon mensual mínimo para quien busca arriendo. `null` = sin mínimo. |
| `dossier.lucia` / `dossier.sonia` | `null` | `{ "url": "https://…/dossier.pdf", "nombre_archivo": "JNdelT.pdf" }`: se envía automáticamente a prioridad baja (archivo en WhatsApp, enlace en Instagram). La URL debe ser pública. |
| `reporte_no_calificados.activo` | `true` | Incluye al tenant en el reporte semanal. |
| `reporte_no_calificados.dias` | `7` | Periodo que cubre cada reporte. |
| `reporte_no_calificados.destinatarios` | `[]` | Correos que reciben el reporte. Vacío = no se envía. |

Las reglas de cada rol (`roles/*.json` → `criterios`) usan estos parámetros con `"parametro": "ruta.en.parametros"`, y pueden aplicar solo a una operación con `"si": { "campo": "operacion", "valor": "arriendo" }`. El seed falla si una regla apunta a un parámetro que no existe.

## Calificación

1. **Datos obligatorios**: si falta alguno, se pide (los de compra o arriendo según `operacion`).
2. **Dirección** (solo Lucía): verificada con Google Maps.
3. **Criterios mínimos**: todas las reglas del rol. Si alguna falla: `no_calificado` con motivo.
4. **Prioridad**: plazo ≤ `prioridad.alta_hasta_meses` → alta → horarios y cita en GoHighLevel. Si no → baja → plantilla `prioridad_baja` (+ dossier si existe), estado `nutricion`, sin cita. Si la persona vuelve con urgencia, pasa a agendar.
