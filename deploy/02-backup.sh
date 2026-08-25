#!/usr/bin/env bash
# Back up the database — and prove the backup restores.
#
# A dump nobody has restored is not a backup, it is a file. This takes the dump
# and then actually loads it into a throwaway PostgreSQL container and counts
# the rows. That container is created and destroyed here and touches nothing
# belonging to the running stack.
#
#   bash 02-backup.sh
set -euo pipefail

CF=/opt/mdt-fastapi/docker-compose.deploy.yml
DC="docker compose -f $CF -p mdt2"
BK=/root/mydesktime-backup
STAMP=$(date +%F-%H%M)
DUMP="$BK/pre-v1.2-$STAMP.sql"

cd /opt/mdt-fastapi
mkdir -p "$BK"

echo "== Dumping =================================================="
# -T matters: without it docker allocates a TTY and mangles the dump with CR
# characters, which you discover only when the restore fails.
$DC exec -T db pg_dump -U sentinel --clean --if-exists sentinel > "$DUMP"
bytes=$(stat -c%s "$DUMP")
echo "  $DUMP  ($(( bytes / 1024 / 1024 )) MB)"

[ "$bytes" -gt 10000 ] || { echo "DUMP IS TOO SMALL — aborting."; exit 1; }
tail -5 "$DUMP" | grep -q 'PostgreSQL database dump complete' \
  || { echo "DUMP IS TRUNCATED (no completion marker) — aborting."; exit 1; }
echo "  completion marker present"

echo
echo "== Proving it restores ======================================"
# A throwaway instance on its own network with no ports published. It cannot
# reach or be reached by the live stack.
docker rm -f mdt-restore-test >/dev/null 2>&1 || true
docker run -d --name mdt-restore-test \
  -e POSTGRES_USER=sentinel -e POSTGRES_PASSWORD=throwaway \
  -e POSTGRES_DB=sentinel postgres:16-alpine >/dev/null
trap 'docker rm -f mdt-restore-test >/dev/null 2>&1 || true' EXIT

printf '  waiting for the throwaway database'
for _ in $(seq 1 60); do
  docker exec mdt-restore-test pg_isready -U sentinel >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
echo

docker exec -i mdt-restore-test psql -U sentinel -d sentinel -q < "$DUMP" >/dev/null 2>&1 || true
echo "  restored. row counts from the RESTORED copy:"
docker exec -i mdt-restore-test psql -U sentinel -d sentinel -tAc "
  SELECT 'organizations '||count(*) FROM organizations
  UNION ALL SELECT 'users '||count(*) FROM users
  UNION ALL SELECT 'devices '||count(*) FROM devices
  UNION ALL SELECT 'screenshots '||count(*) FROM screenshots
  UNION ALL SELECT 'activity_segments '||count(*) FROM activity_segments
" | tr -d '\r' | sed 's/^/    /'

echo
echo "  compare against the live counts taken in pre-flight:"
sed 's/^/    /' "$BK/pre-v1.2-counts.txt" 2>/dev/null || echo "    (no pre-flight counts found)"

echo
echo "  If those two lists do not match, STOP. The backup is incomplete and"
echo "  you have no safety net for the migration."

ln -sfn "$DUMP" "$BK/pre-v1.2-latest.sql"
echo
echo "Backup verified: $DUMP"
echo "Next: bash 03-rehearse-migration.sh"
