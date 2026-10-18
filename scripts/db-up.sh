#!/usr/bin/env bash
# Bring up local PostgreSQL 16 for Student Success OS and make sure the roles
# and database exist. Idempotent: safe to run after every reboot.
#
# Postgres was installed with:  apt-get install -y postgresql-16   (Ubuntu 24.04)
# The cluster lives at /var/lib/postgresql/16/main (root overlay, not /home).
# There is no docker daemon in this environment, so we use the distro cluster.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  echo "PostgreSQL 16 is not installed. Installing (needs root)..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-16
fi

if ! pg_lsclusters -h | awk '$1=="16" && $2=="main"' | grep -q .; then
  pg_createcluster 16 main
fi

if ! pg_lsclusters -h | awk '$1=="16" && $2=="main" {print $4}' | grep -q online; then
  pg_ctlcluster 16 main start
fi

# Wait until it accepts connections.
for _ in $(seq 1 30); do
  if su postgres -c "pg_isready -q -p 5432"; then break; fi
  sleep 0.5
done

# Roles + database (dev-only passwords, match .env.example).
su postgres -c "psql -v ON_ERROR_STOP=1 -q -p 5432" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ssos_owner') THEN
    CREATE ROLE ssos_owner LOGIN PASSWORD 'ssos_owner_dev' NOSUPERUSER BYPASSRLS CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ssos_app') THEN
    CREATE ROLE ssos_app LOGIN PASSWORD 'ssos_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
-- Enforce the invariants even if the roles pre-existed.
ALTER ROLE ssos_owner NOSUPERUSER BYPASSRLS;
ALTER ROLE ssos_app NOSUPERUSER NOBYPASSRLS;
SELECT 'CREATE DATABASE ssos OWNER ssos_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'ssos')\gexec
\c ssos
ALTER SCHEMA public OWNER TO ssos_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ssos_app;
SQL

if [ ! -f "$REPO_ROOT/.env" ]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  echo "Created .env from .env.example"
fi

echo "PostgreSQL 16 is up: database 'ssos', roles ssos_owner (migrations/seed) and ssos_app (runtime, RLS-enforced)."
