#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
environment=${1:?Usage: acornary preacceptance|production COMMAND}; shift
[[ $environment == preacceptance || $environment == production ]] || exit 2
config=/etc/acornary/$environment
compose=(docker compose --env-file "$config/deploy.env" -f /opt/acornary/current/compose.cloud.yaml)
action=${1:?Missing command}; shift
case "$action" in
  owner) "${compose[@]}" --profile ops run --rm admin node dist/apps/server/src/owner.js "$@" ;;
  migrate) "${compose[@]}" --profile ops run --rm admin ;;
  manifest) "${compose[@]}" --profile ops run --rm admin node dist/apps/server/src/manifest.js ;;
  verify-restore) "${compose[@]}" --profile ops run --rm admin node dist/apps/server/src/verify-restore.js "${1:?Restored database name required}" ;;
  initialize)
    [[ $environment == preacceptance ]] || { echo 'Production must be restored, never reinitialized.' >&2; exit 2; }
    "${compose[@]}" --profile ops run --rm admin node dist/apps/server/src/initialize.js ;;
  grants) "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U acornary_migrator -d acornary < /opt/acornary/current/deploy/grants.sql ;;
  start) "${compose[@]}" up -d --wait postgres app ;;
  stop) "${compose[@]}" stop app ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail 80 app ;;
  backup)
    directory=/var/lib/acornary/backups/$environment/$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p "$(dirname "$directory")"
    mkdir -m 700 "$directory"
    "${compose[@]}" exec -T postgres pg_dump -U acornary_migrator --no-owner --no-privileges acornary > "$directory/database.sql.partial"
    mv "$directory/database.sql.partial" "$directory/database.sql"
    sha256sum "$directory/database.sql" > "$directory/database.sha256"
    echo "Backup created: $directory" ;;
  restore-test)
    file=${1:?Supply a backup SQL path}
    [[ -f $file ]] || exit 2
    database=acornary_restore_$(date -u +%Y%m%d%H%M%S)
    "${compose[@]}" exec -T postgres createdb -U acornary_migrator "$database"
    "${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U acornary_migrator -d "$database" < "$file" > /dev/null
    echo "Restored into independent database $database; no application is attached. Inspect and drop explicitly after verification." ;;
  backup-status) systemctl is-enabled acornary-backup.timer || true; systemctl is-active acornary-backup.timer || true ;;
  backup-enable)
    [[ $environment == production ]] || exit 2
    systemctl enable --now acornary-backup.timer ;;
  backup-disable) systemctl disable --now acornary-backup.timer ;;
  *) echo 'Commands: owner, migrate, initialize (test only), grants, start, stop, status, logs, backup, restore-test, backup-status, backup-enable, backup-disable' >&2; exit 2 ;;
esac
