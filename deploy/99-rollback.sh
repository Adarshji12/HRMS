#!/usr/bin/env bash
# Back to 1.1.
#
# Ordinary rollback is just re-pointing the image tags — but not this release.
# v1.2 adds a table, so after it has run the database is at a3f1c72b9d04 while
# 1.1's code expects fab25be2393b, and the API deliberately refuses to start on
# a schema it does not recognise rather than failing on some random query later.
# So the schema has to come back too, and that is what this does.
#
# It restores the compose file and .env from the copies 04-deploy.sh made, so
# any hand edits on this host survive the round trip.
#
#   bash 99-rollback.sh
set -euo pipefail

CF=/opt/mdt-fastapi/docker-compose.deploy.yml
DC="docker compose -f $CF -p mdt2"
BK=/root/mydesktime-backup

cd /opt/mdt-fastapi

echo "This rolls the application back to 1.1 AND reverses the v1.2 migration."
echo "Plans created in the Super Admin console since the deploy will be lost —"
echo "nothing else is touched."
printf 'Type ROLLBACK to continue: '
read -r answer
[ "$answer" = "ROLLBACK" ] || { echo "Aborted. Nothing changed."; exit 1; }

echo
echo "== 1. Safety dump at the current state ====================="
# Taken before reversing anything, so this exact moment stays recoverable.
$DC exec -T db pg_dump -U sentinel --clean --if-exists sentinel \
  > "$BK/pre-rollback-$(date +%F-%H%M).sql"
echo "  written to $BK/"

echo
echo "== 2. Reverse the schema ==================================="
# Run with the 1.2 image, which is the only one that knows the migration.
$DC run --rm --no-deps migrate alembic downgrade fab25be2393b
rev=$($DC exec -T db psql -U sentinel -d sentinel -tAc \
      'SELECT version_num FROM alembic_version' | tr -d '\r' | head -1)
echo "  schema now at: $rev"
[ "$rev" = "fab25be2393b" ] || { echo "  Downgrade did not land. STOP — do not start 1.1 yet."; exit 1; }

echo
echo "== 3. Restore config and image tags ========================"
prev_compose=$(ls -1t "$BK"/compose-before-v1.2-*.yml 2>/dev/null | head -1)
prev_env=$(ls -1t "$BK"/env-before-v1.2-* 2>/dev/null | head -1)
if [ -n "$prev_compose" ]; then cp -a "$prev_compose" "$CF"; echo "  compose restored from $prev_compose"
else
  # No backup to restore: strip the mount rather than leave 1.1 pointing at a
  # directory it has no code to read.
  sed -i '/agent-dist:\/data\/agent/d; /Agent bundles the console offers/d' "$CF"
  echo "  no compose backup found; removed the agent mount line instead"
fi
if [ -n "$prev_env" ]; then cp -a "$prev_env" .env; echo "  .env restored from $prev_env"
else
  sed -i 's|^API_IMAGE=.*|API_IMAGE=mydesktime-api:1.1|' .env
  sed -i 's|^CONSOLE_IMAGE=.*|CONSOLE_IMAGE=mydesktime-console:1.1|' .env
fi
grep -E '^(API_IMAGE|CONSOLE_IMAGE)=' .env | sed 's/^/  /'

echo
echo "== 4. Bring 1.1 back ======================================="
$DC up -d
sleep 5
$DC ps | sed 's/^/  /'

printf '  waiting for the console'
for _ in $(seq 1 45); do
  code=$(curl -so /dev/null -w '%{http_code}' -m 5 http://localhost:4200/ || echo 000)
  [ "$code" = 200 ] && { echo; echo "  back up on 1.1"; exit 0; }
  printf '.'; sleep 2
done
echo
echo "  Console still not answering. Check: $DC logs api --tail 60"
exit 1
