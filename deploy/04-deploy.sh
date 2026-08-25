#!/usr/bin/env bash
# The deploy itself.
#
# Two design choices matter for not disturbing what is running:
#
#  1. Your compose file is EDITED, not replaced. The copy in the repository has
#     no history proving it matches what has been live on this host since the
#     cutover, so overwriting it could silently change a volume name or a
#     published port. This inserts one line into your file and leaves every
#     other line, including anything hand-edited during cutover, untouched.
#
#  2. The change is verified through `docker compose config` — the fully
#     rendered configuration — before anything is recreated. If that diff shows
#     anything beyond the agent mount, the script aborts and restores your file.
#
#   bash 04-deploy.sh
set -euo pipefail

CF=/opt/mdt-fastapi/docker-compose.deploy.yml
DC="docker compose -f $CF -p mdt2"
BK=/root/mydesktime-backup
STAMP=$(date +%F-%H%M)
NEW_API=mydesktime-api:1.2
NEW_CONSOLE=mydesktime-console:1.2
TAR=${1:-/tmp/mydesktime-1.2.tar}

cd /opt/mdt-fastapi
mkdir -p "$BK"

[ -f "$BK/pre-v1.2-latest.sql" ] || { echo "No verified backup. Run 02-backup.sh first."; exit 1; }

echo "== 1. Load the images ======================================"
if docker image inspect "$NEW_API" >/dev/null 2>&1 && docker image inspect "$NEW_CONSOLE" >/dev/null 2>&1; then
  echo "  already loaded"
else
  [ -f "$TAR" ] || { echo "  $TAR not found — transfer it first (WinSCP, Binary mode)"; exit 1; }
  echo "  sha256 of the transferred archive:"
  sha256sum "$TAR" | sed 's/^/    /'
  echo "    expected: af6633333c7f0e7314b1906d36784ef8..."
  echo "    (if the prefix differs, the transfer corrupted it — re-send in Binary mode)"
  docker load -i "$TAR"
fi
docker image inspect "$NEW_API" >/dev/null || exit 1
docker image inspect "$NEW_CONSOLE" >/dev/null || exit 1

echo
echo "== 2. Agent bundle directory ==============================="
# Nothing here can take the site down: if the directory is empty the console
# simply reports that no build is present.
mkdir -p /opt/mdt-fastapi/agent-dist
if [ -f /tmp/MyDeskTime-Agent-Windows.zip ]; then
  cp /tmp/MyDeskTime-Agent-Windows.zip /opt/mdt-fastapi/agent-dist/
  echo "  copied MyDeskTime-Agent-Windows.zip"
fi
chmod 755 /opt/mdt-fastapi/agent-dist
chmod 644 /opt/mdt-fastapi/agent-dist/*.zip 2>/dev/null || true
# The API runs as uid 10001, not root — a 600 file here is invisible to it and
# the panel would show nothing with no error to explain why.
ls -l /opt/mdt-fastapi/agent-dist/ | sed 's/^/  /'

echo
echo "== 3. Add the mount to YOUR compose file ==================="
cp -a "$CF" "$BK/compose-before-v1.2-$STAMP.yml"
echo "  your file backed up to $BK/compose-before-v1.2-$STAMP.yml"

if grep -q '/data/agent' "$CF"; then
  echo "  mount already present — nothing to change"
else
  $DC config > /tmp/mdt-config-before.yml 2>/dev/null

  awk '
    /^  api:[[:space:]]*$/            { in_api = 1 }
    in_api && /^  [a-zA-Z_-]+:[[:space:]]*$/ && !/^  api:/ { in_api = 0 }
    { print }
    in_api && !done && /^      - storage:\/data\/storage[[:space:]]*$/ {
      print "      # Agent bundles the console offers for download (v1.2)."
      print "      - ./agent-dist:/data/agent:ro"
      done = 1; in_api = 0
    }
  ' "$CF" > /tmp/mdt-compose-new.yml

  added=$(grep -c '/data/agent' /tmp/mdt-compose-new.yml || true)
  [ "$added" = "1" ] || { echo "  Could not place the mount (found $added). File UNCHANGED."; exit 1; }

  cp /tmp/mdt-compose-new.yml "$CF"

  if ! $DC config > /tmp/mdt-config-after.yml 2>/tmp/mdt-config-err; then
    echo "  compose rejected the edited file — restoring yours:"
    sed 's/^/    /' /tmp/mdt-config-err
    cp -a "$BK/compose-before-v1.2-$STAMP.yml" "$CF"
    exit 1
  fi

  echo "  rendered-config difference (this must be ONLY the agent mount):"
  diff /tmp/mdt-config-before.yml /tmp/mdt-config-after.yml | sed 's/^/    /' || true
  unexpected=$(diff /tmp/mdt-config-before.yml /tmp/mdt-config-after.yml \
                 | grep -E '^[<>]' | grep -vc 'agent' || true)
  if [ "${unexpected:-0}" -ne 0 ]; then
    echo "  UNEXPECTED changes above — restoring your original file and stopping."
    cp -a "$BK/compose-before-v1.2-$STAMP.yml" "$CF"
    exit 1
  fi
  echo "  verified: only the agent mount changed"
fi

echo
echo "== 4. Point at the new tags ================================"
cp -a .env "$BK/env-before-v1.2-$STAMP"
sed -i "s|^API_IMAGE=.*|API_IMAGE=$NEW_API|"         .env
sed -i "s|^CONSOLE_IMAGE=.*|CONSOLE_IMAGE=$NEW_CONSOLE|" .env
grep -E '^(API_IMAGE|CONSOLE_IMAGE)=' .env | sed 's/^/  /'

echo
echo "== 5. Recreate ============================================="
echo "  agents keep collecting through this — they spool locally and re-upload."
$DC up -d

echo
echo "== 6. Migration result ====================================="
sleep 5
$DC logs migrate --tail 15 | sed 's/^/  /'

echo
printf '  waiting for the API to become healthy'
healthy=0
for _ in $(seq 1 60); do
  code=$(curl -so /dev/null -w '%{http_code}' -m 5 http://localhost:4200/ || echo 000)
  if [ "$code" = 200 ]; then healthy=1; break; fi
  printf '.'; sleep 2
done
echo
if [ "$healthy" = 1 ]; then
  echo "  console is answering"
else
  echo "  CONSOLE NOT ANSWERING. Diagnose before doing anything else:"
  echo "    $DC ps"
  echo "    $DC logs api --tail 60"
  echo "    $DC logs migrate --tail 30"
  echo "  To go back:  bash 99-rollback.sh"
  exit 1
fi

echo
echo "Deployed. Next: bash 05-verify.sh"
