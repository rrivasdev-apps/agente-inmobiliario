'use strict';

// Genera supabase/seed.sql a partir de config/tenants/* y prompts/*.
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
  sql.push(`insert into app.tenants (slug, nombre, zona_horaria, mercado) values (${lit(t.slug)}, ${lit(t.nombre)}, ${lit(t.zona_horaria)}, ${lit(t.mercado)});`);

  for (const c of t.canales) {
    sql.push(`insert into app.canales (tenant_id, tipo, identificador_externo, nombre) values (${tid}, ${lit(c.tipo)}, ${lit(c.identificador_externo)}, ${lit(c.nombre)});`);
  }
  for (const i of t.integraciones) {
    sql.push(`insert into app.integraciones (tenant_id, categoria, proveedor, configuracion, referencia_credencial) values (${tid}, ${lit(i.categoria)}, ${lit(i.proveedor)}, ${json(i.configuracion)}, ${lit(i.referencia_credencial)});`);
  }
  for (const r of roles) {
    const errores = validarCriterios(r.criterios);
    if (errores.length) throw new Error(`${dir}/${r.codigo}: ${errores.join('; ')}`);
    const claves = new Set(r.campos.map((c) => c.clave));
    const desconocidos = r.criterios.campos_obligatorios.filter((c) => !claves.has(c));
    if (desconocidos.length) throw new Error(`${dir}/${r.codigo}: campos obligatorios sin definir: ${desconocidos.join(', ')}`);

    sql.push(
      `insert into app.roles_agente (tenant_id, codigo, nombre_visible, tipo_contacto, prompt_sistema, campos, criterios, requiere_verificacion_direccion, etiqueta_crm) values (${tid}, ${lit(r.codigo)}, ${lit(r.nombre_visible)}, ${lit(r.tipo_contacto)}, ${lit(construirPrompt(r))}, ${json(r.campos)}, ${json(r.criterios)}, ${r.requiere_verificacion_direccion}, ${lit(r.etiqueta_crm)});`,
    );
  }
  for (const p of plantillas) {
    sql.push(`insert into app.plantillas (tenant_id, rol_codigo, clave, texto, requiere_aprobacion_meta) values (${tid}, ${lit(p.rol)}, ${lit(p.clave)}, ${lit(p.texto)}, ${Boolean(p.requiere_aprobacion_meta)});`);
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
