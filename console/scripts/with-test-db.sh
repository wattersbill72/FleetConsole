#!/usr/bin/env bash
# Runs a command against a throwaway local Postgres. Usage: with-test-db.sh "<command>"
# Postgres refuses to run as root, so under root the server runs as the `postgres` user.
set -euo pipefail
CMD="$1"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$PGBIN" ]; then echo "Postgres server binaries not found (looked in /usr/lib/postgresql)"; exit 1; fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(mktemp -d)"
PORT="${TEST_PG_PORT:-54329}"
if [ "$(id -u)" = "0" ]; then
  chown postgres "$DIR"
  AS="runuser -u postgres --"
else
  AS=""
fi
cleanup() { $AS "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

$AS "$PGBIN/initdb" -D "$DIR/data" -A trust -U postgres >/dev/null
$AS "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
$AS "$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U postgres fleet_test

export DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/fleet_test"
export SESSION_SECRET="test-secret-$(date +%s)-0123456789abcdef"
cd "$ROOT"
node scripts/migrate.mjs >/dev/null
bash -c "$CMD"
