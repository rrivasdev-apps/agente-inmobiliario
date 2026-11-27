# Panel de configuración

**Decisión (26 nov 2026, Rafael):** Javier configura el agente desde un panel web con acceso restringido. Supabase es la fuente de verdad de los parámetros; `tenant.json` queda como valores iniciales de un tenant nuevo.

Código en `panel/` (Next.js 16 + Supabase Auth). Migración `0020_panel_configuracion.sql`.

## Qué se configura (v1)

| Página | Qué hace |
|---|---|
| **Parámetros** | Valor mínimo, tolerancia y premium; relaciones válidas y tipos de inmueble; prioridad y recordatorio; mínimos de compra y arriendo; propuesta comercial; dossier; nutrición; conversación; reporte semanal. El catálogo está en `panel/lib/parametros.ts`: cada campo tiene su etiqueta, ayuda y validación. |
| **Cobertura** | Agregar, activar y desactivar ciudades (`app.ciudades_cobertura`). Consultar barrios: se siguen editando en la hoja de Google, que se sincroniza a diario y con el botón «Sincronizar ahora» (migración 0023), y pisaría cualquier cambio hecho en el panel. |
| **Historial** | Los últimos 100 cambios de parámetros: qué, antes, después, cuándo y quién. |

Fuera de la v1: agenda de llamadas (ventanas, festivos, vacaciones), plantillas y prompts, usuarios del reporte.

## Seguridad

- **Acceso:** enlace por correo (Supabase Auth, sin contraseña). `shouldCreateUser: false`: un correo desconocido no crea cuenta ni se le dice si existe.
- **Autorización:** la da la membresía en `app.miembros_tenant`. `admin_plataforma` y `admin_operacion` editan; `asesor` ve en solo lectura. Sin membresía, el tenant responde 404.
- **La BD decide, no el panel:** el panel usa la clave pública y la sesión de la persona, nunca `service_role`. `app.tenants` solo se puede leer con RLS; los parámetros se cambian únicamente con `app.actualizar_parametros`, que exige ser admin del tenant, rechaza rutas que no existen y tipos distintos, y escribe `app.cambios_configuracion`.
- Todas las tablas del esquema `app` tienen RLS (verificado el 26 nov 2026), requisito para exponer el esquema a la API.

## Pensado para SaaS

Las rutas son por tenant (`/t/<slug>/…`), los permisos salen de la membresía y el catálogo solo muestra los campos que existen en los parámetros de cada tenant. Agregar un cliente nuevo no requiere tocar el panel: crear el tenant (seed) y darle membresía a su administrador.

## Puesta en marcha

Hecho en `db_inmuebles` el 26 nov 2026:

- Migraciones 0020 y 0021 y el seed aplicados (0021 da a `authenticated` los permisos sobre `ciudades_cobertura` y `usuarios`, que 0009 no había dado).
- Esquema `app` expuesto en Data API → Exposed schemas.
- Correo por Resend (Authentication → Emails → SMTP), límite de 30 correos por hora.
- Plantillas de *Magic link* e *Invite* en español con `token_hash`: el enlace lleva a `/auth/confirm`, que no inicia sesión al abrirse (los revisores de enlaces del correo lo gastarían) sino al pulsar **Entrar**, y funciona en cualquier navegador.
  - Magic link: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email`
  - Invite: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
- Usuario de Rafael con `admin_plataforma`. Redirect URL permitida: `http://localhost:3100/auth/confirm`.

Pendiente:

1. **Desplegar** `panel/` en Vercel (Root Directory: `panel`) con las variables de `panel/.env.example`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (clave pública, nunca la secreta) y `NEXT_PUBLIC_SITE_URL`.
2. **URLs de Auth:** *Site URL* = URL del panel (la usa la invitación) y agregar `<URL del panel>/auth/confirm` a *Redirect URLs*.
3. **Invitar a Javier** (Authentication → Users → *Invite user*) y darle membresía:
   ```sql
   insert into app.miembros_tenant (tenant_id, user_id, rol)
   select t.id, u.id, 'admin_operacion'
   from app.tenants t, auth.users u
   where t.slug = 'javier-nunez' and u.email = '<correo de Javier>';
   ```
4. Recomendado: desactivar el registro público (Authentication → Sign In / Providers → *Allow new users to sign up*); las invitaciones siguen funcionando.

## Trabajar en local

```bash
cd panel
npm install
cp .env.example .env.local   # completar con la URL y la clave pública de Supabase
npm run dev                  # http://localhost:3100 (acepta cabeceras de 64 KB: las cookies de
                             # otras apps en localhost causaban HTTP 431)
npm test                     # catálogo y validaciones
npm run typecheck
```
