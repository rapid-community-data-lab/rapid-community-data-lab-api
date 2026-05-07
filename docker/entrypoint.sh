#!/bin/sh
# Entrypoint for the rapid-community-data-lab-api container.
# Waits for Postgres + OpenSearch, applies the Prisma schema, then runs the server.
set -e

DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
OPENSEARCH_HOST="${OPENSEARCH_HOST:-opensearch}"
OPENSEARCH_PORT="${OPENSEARCH_PORT:-9200}"

wait_for() {
  host="$1"; port="$2"; name="$3"
  echo "[entrypoint] Waiting for ${name} at ${host}:${port}..."
  i=0
  while ! nc -z "$host" "$port" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "[entrypoint] Timed out waiting for ${name} at ${host}:${port}" >&2
      exit 1
    fi
    sleep 1
  done
  echo "[entrypoint] ${name} is up."
}

# nc is provided by busybox in node:alpine.
wait_for "$DB_HOST" "$DB_PORT" "postgres"
wait_for "$OPENSEARCH_HOST" "$OPENSEARCH_PORT" "opensearch"

# Idempotent schema sync; safe to re-run on every start.
echo "[entrypoint] Applying Prisma schema (db push)..."
npx --yes prisma db push --accept-data-loss

echo "[entrypoint] Starting: $*"
exec "$@"


