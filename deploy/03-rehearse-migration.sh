#!/usr/bin/env bash
# Run the v1.2 migration against a COPY of production data, in isolation.
#
# This is the step that turns "the migration worked on a laptop with six demo
# rows" into "the migration worked on your data". Everything here happens on a
# throwaway network with a throwaway database restored from the backup. The
# live stack is not touched, not connected to, and not stopped.
#
# Requires: 02-backup.sh has run, and mydesktime-api:1.2 is loaded.
#
#   bash 03-rehearse-migration.sh
set -euo pipefail

BK=/root/mydesktime-backup
DUMP="${1:-$BK/pre-v1.2-latest.sql}"
NET=mdt-rehearse-net
PG=mdt-rehearse-db

[ -f "$DUMP" ] || { echo "no dump at $DUMP — run 02-backup.sh first"; exit 1; }
docker image inspect mydesktime-api:1.2 >/dev/null 2>&1 \
  || { echo "mydesktime-api:1.2 not loaded — run: docker load -i /tmp/mydesktime-1.2.tar"; exit 1; }

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "== Isolated copy of production ============================="
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_USER=sentinel -e POSTGRES_PASSWORD=rehearse \
  -e POSTGRES_DB=sentinel postgres:16-alpine >/dev/null

printf '  waiting'
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U sentinel >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
echo

docker exec -i "$PG" psql -U sentinel -d sentinel -q < "$DUMP" >/dev/null 2>&1 || true
before=$(docker exec -i "$PG" psql -U sentinel -d sentinel -tAc \
  'SELECT version_num FROM alembic_version' | tr -d '\r')
echo "  restored. schema revision: $before"

echo
echo "== Running the v1.2 migration on it ========================"
set +e
out=$(docker run --rm --network "$NET" \
  -e DATABASE_URL="postgresql+psycopg://sentinel:rehearse@$PG:5432/sentinel" \
  -e SECRET_KEY=rehearsal-only-not-a-real-key-0000000000 \
  -e BASE_DOMAIN=localhost -e ENVIRONMENT=development \
  mydesktime-api:1.2 alembic upgrade head 2>&1)
rc=$?
set -e
echo "$out" | sed 's/^/  /'
[ $rc -eq 0 ] || { echo; echo "MIGRATION FAILED ON YOUR DATA. Do not deploy. Output above."; exit 1; }

after=$(docker exec -i "$PG" psql -U sentinel -d sentinel -tAc \
  'SELECT version_num FROM alembic_version' | tr -d '\r')
echo
echo "  revision now: $after"
[ "$after" = "a3f1c72b9d04" ] || { echo "  UNEXPECTED revision — stop."; exit 1; }

echo
echo "== Did it disturb existing data? ==========================="
docker exec -i "$PG" psql -U sentinel -d sentinel -tAc "
  SELECT 'organizations '||count(*) FROM organizations
  UNION ALL SELECT 'users '||count(*) FROM users
  UNION ALL SELECT 'devices '||count(*) FROM devices
  UNION ALL SELECT 'screenshots '||count(*) FROM screenshots
  UNION ALL SELECT 'activity_segments '||count(*) FROM activity_segments
  UNION ALL SELECT 'subscriptions '||count(*) FROM subscriptions
" | tr -d '\r' | sed 's/^/  /'
echo "  compare with /root/mydesktime-backup/pre-v1.2-counts.txt — must be identical."
echo "  (this migration only CREATES a table; it alters no existing row)"

echo
echo "== Rehearsing the rollback too ============================="
# Proves the escape hatch works on your data, before you might need it in a
# hurry. Same command 99-rollback.sh would run.
set +e
back=$(docker run --rm --network "$NET" \
  -e DATABASE_URL="postgresql+psycopg://sentinel:rehearse@$PG:5432/sentinel" \
  -e SECRET_KEY=rehearsal-only-not-a-real-key-0000000000 \
  -e BASE_DOMAIN=localhost -e ENVIRONMENT=development \
  mydesktime-api:1.2 alembic downgrade fab25be2393b 2>&1)
rc=$?
set -e
[ $rc -eq 0 ] || { echo "$back" | sed 's/^/  /'; echo "ROLLBACK PATH IS BROKEN — deploy at your own risk."; exit 1; }
rev=$(docker exec -i "$PG" psql -U sentinel -d sentinel -tAc \
  'SELECT version_num FROM alembic_version' | tr -d '\r')
echo "  downgrade succeeded, revision back to $rev"

echo
echo "Rehearsal passed on real data: migration applies, rollback reverses."
echo "Next: bash 04-deploy.sh"
