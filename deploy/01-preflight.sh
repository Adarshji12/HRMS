#!/usr/bin/env bash
# Pre-flight for the v1.2 deploy. CHANGES NOTHING — read-only.
#
# Run this first and read the output. It answers the questions that decide
# whether the deploy is safe to start at all: is there disk for another 600 MB
# of images, is the stack actually healthy right now, and is what is running
# what you think is running.
#
#   bash 01-preflight.sh
set -uo pipefail

CF=/opt/mdt-fastapi/docker-compose.deploy.yml
DC="docker compose -f $CF -p mdt2"
fail=0
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
bad()  { printf '  \033[31mX %s\033[0m\n' "$*"; fail=1; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }

cd /opt/mdt-fastapi || { echo "no /opt/mdt-fastapi"; exit 1; }

echo "== 1. Disk =================================================="
# The single most likely way to hurt a working system here. docker load writes
# ~600 MB; if / fills, PostgreSQL stops being able to write and you have a real
# outage caused by a deploy that had not even started yet.
avail_kb=$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}')
avail_kb=${avail_kb:-$(df -Pk / | awk 'NR==2{print $4}')}
avail_gb=$(( avail_kb / 1024 / 1024 ))
df -h / /var/lib/docker 2>/dev/null | sed 's/^/  /'
if   [ "$avail_gb" -lt 3 ]; then bad "only ${avail_gb} GB free — need 3 GB+. Do NOT deploy. Free space first."
elif [ "$avail_gb" -lt 6 ]; then warn "${avail_gb} GB free. Enough, but tight. See 'Reclaiming space' in the README."
else ok "${avail_gb} GB free"
fi

echo
echo "== 2. What is running right now ============================="
$DC ps 2>/dev/null | sed 's/^/  /'
running=$($DC ps --services --filter status=running 2>/dev/null | sort | tr '\n' ' ')
echo "  running services: ${running:-<none>}"
for svc in db api console jobs; do
  echo "$running" | grep -qw "$svc" || bad "service '$svc' is NOT running — fix that before deploying, not during"
done
echo "$running" | grep -qw db && ok "db up"

echo
echo "== 3. Live image tags (your rollback target) ================"
$DC config --images 2>/dev/null | sed 's/^/  /'
grep -E '^(API_IMAGE|CONSOLE_IMAGE)=' .env 2>/dev/null | sed 's/^/  .env: /'
for t in mydesktime-api:1.1 mydesktime-console:1.1; do
  if docker image inspect "$t" >/dev/null 2>&1; then ok "$t present (rollback possible)"
  else bad "$t MISSING — you would have nothing to roll back to"; fi
done

echo
echo "== 4. The data. These must exist and must never be deleted. =="
for v in mdt2_pgdata mdt2_storage; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    ok "$v  ->  $(docker volume inspect -f '{{.Mountpoint}}' "$v")"
  else bad "$v missing"; fi
done
echo "  other volumes on this host (the old vendor's data — leave alone):"
docker volume ls --format '    {{.Name}}' | grep -v '^    mdt2_' | sed 's/$//'

echo
echo "== 5. Schema position ======================================="
cur=$($DC exec -T db psql -U sentinel -d sentinel -tAc \
      'SELECT version_num FROM alembic_version' 2>/dev/null | tr -d '\r' | head -1)
echo "  database is at: ${cur:-<could not read>}"
if [ "$cur" = "fab25be2393b" ]; then
  ok "expected pre-1.2 revision — the v1.2 migration will apply cleanly"
elif [ "$cur" = "a3f1c72b9d04" ]; then
  warn "already at the v1.2 revision. A previous attempt got this far; the"
  warn "migration will be a no-op. That is fine, but know it before you start."
else
  bad "unexpected revision '$cur'. STOP and work out why before deploying."
fi

echo
echo "== 6. Live app health ======================================="
code=$(curl -so /dev/null -w '%{http_code}' -m 10 http://localhost:4200/ || echo 000)
[ "$code" = 200 ] && ok "console responds 200" || bad "console returned $code"
agent=$(curl -so /dev/null -w '%{http_code}' -m 10 http://localhost:4200/api/v1/admin/agent/bundles || echo 000)
echo "  /api/v1/admin/agent/bundles -> $agent   (404 = 1.1 as expected; 401 = 1.2 already live)"

echo
echo "== 7. Working data, to compare against afterwards ==========="
$DC exec -T db psql -U sentinel -d sentinel -tAc "
  SELECT 'organizations '||count(*) FROM organizations
  UNION ALL SELECT 'users '||count(*) FROM users
  UNION ALL SELECT 'devices '||count(*) FROM devices
  UNION ALL SELECT 'screenshots '||count(*) FROM screenshots
  UNION ALL SELECT 'activity_segments '||count(*) FROM activity_segments
  UNION ALL SELECT 'subscriptions '||count(*) FROM subscriptions
" 2>/dev/null | tr -d '\r' | sed 's/^/  /' | tee /root/mydesktime-backup/pre-v1.2-counts.txt
echo "  (saved to /root/mydesktime-backup/pre-v1.2-counts.txt — 05-verify.sh re-checks these)"

echo
echo "============================================================"
if [ "$fail" -ne 0 ]; then
  printf '\033[31mPRE-FLIGHT FAILED — do not proceed until the X lines above are resolved.\033[0m\n'
  exit 1
fi
printf '\033[32mPre-flight clear. Next: bash 02-backup.sh\033[0m\n'
