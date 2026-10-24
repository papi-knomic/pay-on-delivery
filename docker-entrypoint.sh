#!/bin/sh
# Migrate, then start. `set -e` makes a failed migration stop the container (loud failure, no half-migrated app).
# Migrations are idempotent (Drizzle tracks applied ones) and serialized with a Postgres advisory lock.
set -eu

echo "[entrypoint] running database migrations"
node dist/db/migrate.js

echo "[entrypoint] starting server"
exec node dist/server.js
