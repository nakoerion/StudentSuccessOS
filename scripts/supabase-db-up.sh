#!/usr/bin/env bash
# Point Student Success OS at the owner's Supabase Postgres.
#
#   source /etc/profile.d/cto-env-vars.sh   # provides SUPABASE_DB_URL (+ SUPABASE_* auth keys)
#   bash scripts/supabase-db-up.sh          # roles + grants + .env (idempotent)
#   pnpm db:migrate && pnpm db:seed && pnpm auth:seed
#
# What it does (the Supabase twin of scripts/db-up.sh):
#   1. Connects as the Supabase `postgres` role (SUPABASE_DB_URL). That role is not a
#      true superuser on Supabase, but it HAS BYPASSRLS, so the app must never run as it.
#   2. Creates/updates two roles, mirroring db-up.sh exactly:
#        ssos_owner  NOSUPERUSER BYPASSRLS   -> owns the schema objects, runs migrations + seed
#        ssos_app    NOSUPERUSER NOBYPASSRLS -> runtime; every query is subject to RLS
#      Table/function grants for ssos_app come from the RLS generator's migrations, as locally.
#      Objects are created by ssos_owner, so Supabase's default privileges for `postgres`
#      (which grant ALL on new public tables to anon/authenticated/service_role) do NOT apply:
#      the Data API roles get no access to SSOS tables.
#   3. Writes DATABASE_URL (ssos_app via the transaction pooler) and DATABASE_ADMIN_URL
#      (ssos_owner via the session pooler, or the direct host if it is reachable) into .env.
#
# Role passwords are generated once and kept OUTSIDE the repo in $SSOS_SUPABASE_SECRETS
# (chmod 600). Re-running reuses them, so a deployed app keeps working.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${SSOS_SUPABASE_SECRETS:-/home/team/shared/.secrets/sso-supabase-roles.env}"
# Supavisor host for the project's region (not secret). Find yours in Supabase:
# Project -> Connect -> "Transaction pooler" / "Session pooler".
POOLER_HOST="${SUPABASE_POOLER_HOST:-aws-1-ap-southeast-1.pooler.supabase.com}"

: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set (source /etc/profile.d/cto-env-vars.sh)}"

# Parse the direct URL: postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres
eval "$(python3 - <<'PY'
import os, shlex, urllib.parse as u
p = u.urlparse(os.environ["SUPABASE_DB_URL"])
host = p.hostname or ""
ref = host.split(".")[1] if host.startswith("db.") else ""
print("SB_HOST=" + shlex.quote(host))
print("SB_PORT=" + shlex.quote(str(p.port or 5432)))
print("SB_USER=" + shlex.quote(u.unquote(p.username or "postgres")))
print("SB_PASS=" + shlex.quote(u.unquote(p.password or "")))
print("SB_DB=" + shlex.quote((p.path or "/postgres").lstrip("/") or "postgres"))
print("SB_REF=" + shlex.quote(ref))
PY
)"
[ -n "$SB_REF" ] || { echo "Could not derive the project ref from SUPABASE_DB_URL host '$SB_HOST'" >&2; exit 1; }

# The direct host (db.<ref>.supabase.co) is IPv6-only unless the IPv4 add-on is enabled.
# Use it when it resolves; otherwise use the session pooler (same semantics, IPv4).
if getent ahosts "$SB_HOST" >/dev/null 2>&1; then
  ADMIN_HOST="$SB_HOST"; ADMIN_PORT="$SB_PORT"; ADMIN_SUFFIX=""
  echo "Direct host $SB_HOST resolves: migrations/seed use the direct connection."
else
  ADMIN_HOST="$POOLER_HOST"; ADMIN_PORT=5432; ADMIN_SUFFIX=".$SB_REF"
  echo "Direct host $SB_HOST does not resolve here (IPv6-only): migrations/seed use the session pooler $POOLER_HOST:5432."
fi

# Role passwords: generate once, keep outside git.
mkdir -p "$(dirname "$SECRETS_FILE")"
if [ ! -f "$SECRETS_FILE" ]; then
  umask 077
  {
    echo "SSOS_APP_PASSWORD=$(openssl rand -hex 24)"
    echo "SSOS_OWNER_PASSWORD=$(openssl rand -hex 24)"
  } >"$SECRETS_FILE"
  echo "Generated role passwords in $SECRETS_FILE"
fi
chmod 600 "$SECRETS_FILE"
# shellcheck disable=SC1090
. "$SECRETS_FILE"

PGPASSWORD="$SB_PASS" psql "host=$ADMIN_HOST port=$ADMIN_PORT user=$SB_USER$ADMIN_SUFFIX dbname=$SB_DB sslmode=require" \
  -v ON_ERROR_STOP=1 -q -v app_pw="$SSOS_APP_PASSWORD" -v owner_pw="$SSOS_OWNER_PASSWORD" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ssos_owner') AS mk_owner \gset
\if :mk_owner
  CREATE ROLE ssos_owner LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
\endif
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ssos_app') AS mk_app \gset
\if :mk_app
  CREATE ROLE ssos_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
\endif
-- Enforce the invariants even if the roles pre-existed (same as db-up.sh).
ALTER ROLE ssos_owner LOGIN BYPASSRLS PASSWORD :'owner_pw';
ALTER ROLE ssos_app LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
-- Supabase's postgres role may not mention SUPERUSER in ALTER ROLE (it is not a
-- superuser itself), so assert the invariant instead of re-stating it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ssos_app', 'ssos_owner') AND rolsuper)
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ssos_app' AND rolbypassrls) THEN
    RAISE EXCEPTION 'ssos_app must be NOSUPERUSER NOBYPASSRLS and ssos_owner NOSUPERUSER';
  END IF;
END
$$;
-- Supabase's public schema belongs to pg_database_owner and cannot be handed over,
-- so ssos_owner gets CREATE on it instead of ownership. ssos_app only ever gets USAGE
-- (+ the table/function grants emitted by the RLS generator migrations).
GRANT USAGE, CREATE ON SCHEMA public TO ssos_owner;
-- The init migration starts with `CREATE SCHEMA IF NOT EXISTS "public"`, which checks
-- CREATE on the database before noticing the schema exists.
SELECT format('GRANT CREATE ON DATABASE %I TO ssos_owner', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO ssos_app;
REVOKE CREATE ON SCHEMA public FROM ssos_app;
-- Let the dashboard/postgres role administer SSOS objects (e.g. emergency fixes).
GRANT ssos_owner TO postgres;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('ssos_owner', 'ssos_app') ORDER BY 1;
SQL

APP_URL="postgresql://ssos_app.$SB_REF:$SSOS_APP_PASSWORD@$POOLER_HOST:6543/$SB_DB?pgbouncer=true&connection_limit=5&sslmode=require"
ADMIN_URL="postgresql://ssos_owner$ADMIN_SUFFIX:$SSOS_OWNER_PASSWORD@$ADMIN_HOST:$ADMIN_PORT/$SB_DB?sslmode=require"

ENV_FILE="$REPO_ROOT/.env"
[ -f "$ENV_FILE" ] || cp "$REPO_ROOT/.env.example" "$ENV_FILE"
set_env() {
  local key="$1" val="$2"
  python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys, re
path, key, val = sys.argv[1:]
lines = open(path).read().splitlines()
line = f'{key}="{val}"'
for i, l in enumerate(lines):
    if re.match(rf"^{re.escape(key)}=", l):
        lines[i] = line
        break
else:
    lines.append(line)
open(path, "w").write("\n".join(lines) + "\n")
PY
}
set_env DATABASE_URL "$APP_URL"
set_env DATABASE_ADMIN_URL "$ADMIN_URL"
for k in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY; do
  if [ -n "${!k:-}" ]; then set_env "$k" "${!k}"; fi
done
chmod 600 "$ENV_FILE"
echo "Wrote DATABASE_URL (ssos_app @ $POOLER_HOST:6543, transaction pooler) and DATABASE_ADMIN_URL (ssos_owner @ $ADMIN_HOST:$ADMIN_PORT) to .env"
echo "Next: pnpm db:migrate && pnpm db:seed && pnpm auth:seed"
