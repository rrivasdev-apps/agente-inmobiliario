# Agente de captación y calificación inmobiliaria

Agente conversacional para el equipo de Javier Núñez (Bogotá) con dos roles:

- **Lucía**: atiende propietarios que quieren vender; verifica la dirección con Google Maps.
- **Sonia**: atiende compradores; califica por perfil, presupuesto, intención y horizonte.

El flujo termina cuando un contacto calificado **confirma una cita**. Solo entonces se asigna y se entrega al asesor.

Stack: Meta (WhatsApp / Instagram) · n8n · OpenAI · Supabase · Google Maps · GoHighLevel.

## Estructura

```
config/tenants/<tenant>/      Configuración por empresa (fuente del seed)
  tenant.json                 Canales e integraciones
  roles/lucia.json, sonia.json  Campos, criterios y etiqueta CRM
  plantillas.json             Textos conversacionales (PRD §7)
prompts/                      Prompts de sistema (común, Lucía, Sonia, clasificador)
src/calificacion/evaluar.js   Motor de calificación determinista (sin dependencias)
supabase/migrations/          Esquema de base de datos
supabase/seed.sql             GENERADO desde config/ y prompts/
tests/                        Pruebas del evaluador y de la base de datos
docs/                         Arquitectura y plan de implementación
```

## Comandos

```bash
npm test            # pruebas del motor de calificación
npm run test:db     # migración + seed + reglas de negocio en un Postgres temporal
npm run seed        # regenera supabase/seed.sql tras editar config/ o prompts/
npm run seed:check  # verifica que el seed está actualizado
```

`test:db` requiere PostgreSQL 15+ instalado localmente (`initdb`, `pg_ctl`, `psql`).

## Documentación

- [Arquitectura](docs/arquitectura.md)
- [Plan y decisiones pendientes](docs/plan.md)
