#!/usr/bin/env bash
# Aplica la migración y el seed en un Postgres temporal y ejecuta tests/db.
set -euo pipefail

raiz="$(cd "$(dirname "$0")/.." && pwd)"
bin="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
datos="$(mktemp -d)"
puerto="${PG_PORT:-54329}"

limpiar() { "$bin/pg_ctl" -D "$datos" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$datos"; }
trap limpiar EXIT

# initdb no puede ejecutarse como root.
como=()
if [ "$(id -u)" = "0" ]; then chown -R postgres "$datos"; como=(runuser -u postgres --); fi

"${como[@]}" "$bin/initdb" -D "$datos" -U postgres -A trust >/dev/null
"${como[@]}" "$bin/pg_ctl" -D "$datos" -o "-p $puerto -k $datos -c listen_addresses=''" -w start >/dev/null

psql_() { psql -h "$datos" -p "$puerto" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_ -f "$raiz/tests/db/00_supabase_stub.sql"
for m in "$raiz"/supabase/migrations/*.sql; do psql_ -f "$m"; done
psql_ -f "$raiz/supabase/seed.sql"
# El seed es idempotente: aplicarlo dos veces no duplica nada.
psql_ -f "$raiz/supabase/seed.sql"
for t in "$raiz"/tests/db/[1-9]*.sql; do psql_ -o /dev/null -f "$t"; done
echo "Pruebas de base de datos: OK"
