'use strict';

// Genera supabase/seed.sql a partir de config/tenants/* y prompts/*.
// El seed es idempotente (upserts): se puede volver a aplicar en una BD con
// datos para publicar cambios de configuración.
// Uso: node scripts/generar-seed.js [--check]
//   --check  falla si supabase/seed.sql no está actualizado.

const fs = require('node:fs');
const path = require('node:path');
const { validarCriterios } = require('../src/calificacion/evaluar');

const raiz = path.resolve(__dirname, '..');
const leer = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');
const leerJson = (...p) => JSON.parse(leer(...p));

const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const json = (v) => `${lit(JSON.stringify(v))}::jsonb`;

function construirPrompt(rol) {
  const campos = rol.campos.map((c) => `- ${c.clave}: ${c.etiqueta}${c.descripcion ? ` (${c.descripcion})` : ''}`).join('\n');
  return `${leer('prompts', 'comun.md').trim()}\n\n${leer('prompts', `${rol.codigo}.md`).trim()}`.replace('{{campos}}', campos);
}

function existeRuta(obj, ruta) {
  let actual = obj;
  for (const parte of ruta.split('.')) {
    if (!actual || typeof actual !== 'object' || !(parte in actual)) return false;
    actual = actual[parte];
  }
  return true;
}

function validarRol(dir, r, parametros) {
  const errores = validarCriterios(r.criterios);
  const claves = new Set(r.campos.map((c) => c.clave));
  const campos = r.criterios.campos_obligatorios.map((c) => (typeof c === 'string' ? c : c.campo));
  const desconocidos = campos.filter((c) => !claves.has(c));
  if (desconocidos.length) errores.push(`campos obligatorios sin definir: ${desconocidos.join(', ')}`);
  const rutas = [...r.criterios.reglas.map((x) => x.parametro), r.criterios.prioridad && r.criterios.prioridad.parametro]
    .filter((x) => typeof x === 'string');
  const sinParametro = rutas.filter((ruta) => !existeRuta(parametros, ruta));
  if (sinParametro.length) errores.push(`parámetros no definidos en tenant.json: ${sinParametro.join(', ')}`);
  if (errores.length) throw new Error(`${dir}/${r.codigo}: ${errores.join('; ')}`);
}

function generarTenant(dir) {
  const t = leerJson('config', 'tenants', dir, 'tenant.json');
  const roles = fs.readdirSync(path.join(raiz, 'config', 'tenants', dir, 'roles'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => leerJson('config', 'tenants', dir, 'roles', f));
  const plantillas = leerJson('config', 'tenants', dir, 'plantillas.json');

  const sql = [];
  const tid = `(select id from app.tenants where slug = ${lit(t.slug)})`;

  sql.push(`-- Tenant: ${t.nombre}`);
  const parametros = t.parametros || {};
  sql.push(`insert into app.tenants (slug, nombre, zona_horaria, mercado, parametros) values (${lit(t.slug)}, ${lit(t.nombre)}, ${lit(t.zona_horaria)}, ${lit(t.mercado)}, ${json(parametros)})`
    + ' on conflict (slug) do update set nombre = excluded.nombre, zona_horaria = excluded.zona_horaria, mercado = excluded.mercado, parametros = excluded.parametros;');

  for (const c of t.canales) {
    sql.push(`insert into app.canales (tenant_id, tipo, identificador_externo, nombre) values (${tid}, ${lit(c.tipo)}, ${lit(c.identificador_externo)}, ${lit(c.nombre)})`
      + ' on conflict (tipo, identificador_externo) do update set nombre = excluded.nombre;');
  }
  for (const i of t.integraciones) {
    sql.push(`insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values (${tid}, ${lit(i.categoria)}, ${lit(i.proveedor)}, ${json(i.configuracion)}, ${lit(i.referencia_credencial)})`
      + ' on conflict (tenant_id, categoria) where activo do update set proveedor = excluded.proveedor, configuracion = excluded.configuracion, referencia_credencial = excluded.referencia_credencial;');
  }
  for (const r of roles) {
    validarRol(dir, r, parametros);
    sql.push(
      `insert into app.roles_agente (tenant_id, codigo, nombre_visible, tipo_contacto, prompt_sistema, campos, criterios, requiere_verificacion_direccion, etiqueta_crm) values (${tid}, ${lit(r.codigo)}, ${lit(r.nombre_visible)}, ${lit(r.tipo_contacto)}, ${lit(construirPrompt(r))}, ${json(r.campos)}, ${json(r.criterios)}, ${r.requiere_verificacion_direccion}, ${lit(r.etiqueta_crm)})`
      + ' on conflict (tenant_id, codigo) do update set nombre_visible = excluded.nombre_visible, tipo_contacto = excluded.tipo_contacto, prompt_sistema = excluded.prompt_sistema, campos = excluded.campos, criterios = excluded.criterios, requiere_verificacion_direccion = excluded.requiere_verificacion_direccion, etiqueta_crm = excluded.etiqueta_crm;',
    );
  }
  for (const p of plantillas) {
    const conflicto = p.rol ? '(tenant_id, rol_codigo, clave) where rol_codigo is not null' : '(tenant_id, clave) where rol_codigo is null';
    sql.push(`insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values (${tid}, ${lit(p.rol)}, ${lit(p.clave)}, ${lit(p.texto)}, ${Boolean(p.requiere_aprobacion_meta)})`
      + ` on conflict ${conflicto} do update set texto = excluded.texto, requiere_aprobacion_meta = excluded.requiere_aprobacion_meta;`);
  }
  return sql.join('\n');
}

function generar() {
  const tenants = fs.readdirSync(path.join(raiz, 'config', 'tenants')).sort();
  return [
    '-- ARCHIVO GENERADO por scripts/generar-seed.js. No editar a mano.',
    '-- Fuente: config/tenants/* y prompts/*',
    '',
    'begin;',
    ...tenants.map(generarTenant),
    'commit;',
    '',
  ].join('\n');
}

const destino = path.join(raiz, 'supabase', 'seed.sql');
const contenido = generar();

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(destino) ? fs.readFileSync(destino, 'utf8') : '';
  if (actual !== contenido) {
    console.error('supabase/seed.sql no está actualizado. Ejecuta: node scripts/generar-seed.js');
    process.exit(1);
  }
  console.log('supabase/seed.sql está actualizado.');
} else {
  fs.writeFileSync(destino, contenido);
  console.log(`Generado ${path.relative(raiz, destino)}`);
}
