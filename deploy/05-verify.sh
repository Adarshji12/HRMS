#!/usr/bin/env bash
# Post-deploy verification. Read-only.
#
# Checks two separate things, and the second matters more than the first:
#   - the new features are actually live
#   - everything that was working before still works and no data moved
#
#   bash 05-verify.sh
set -uo pipefail

CF=/opt/mdt-fastapi/docker-compose.deploy.yml
DC="docker compose -f $CF -p mdt2"
BK=/root/mydesktime-backup
fail=0
ok()  { printf '  \033[32mok\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mX %s\033[0m\n' "$*"; fail=1; }

cd /opt/mdt-fastapi

echo "== Containers =============================================="
$DC ps | sed 's/^/  /'
echo "  (migrate showing Exited (0) is correct — it runs once and stops)"
for svc in db api console jobs; do
  $DC ps --services --filter status=running | grep -qw "$svc" \
    && ok "$svc running" || bad "$svc NOT running"
done

echo
echo "== Running the intended images ============================="
$DC config --images | sed 's/^/  /'
$DC config --images | grep -q 'mydesktime-api:1.2' && ok "api on 1.2" || bad "api not on 1.2"
$DC config --images | grep -q 'mydesktime-console:1.2' && ok "console on 1.2" || bad "console not on 1.2"

echo
echo "== Schema =================================================="
rev=$($DC exec -T db psql -U sentinel -d sentinel -tAc \
      'SELECT version_num FROM alembic_version' 2>/dev/null | tr -d '\r' | head -1)
[ "$rev" = "a3f1c72b9d04" ] && ok "at a3f1c72b9d04" || bad "at '$rev', expected a3f1c72b9d04"

echo
echo "== NOTHING WAS LOST ========================================"
echo "  before -> now:"
$DC exec -T db psql -U sentinel -d sentinel -tAc "
  SELECT 'organizations '||count(*) FROM organizations
  UNION ALL SELECT 'users '||count(*) FROM users
  UNION ALL SELECT 'devices '||count(*) FROM devices
  UNION ALL SELECT 'screenshots '||count(*) FROM screenshots
  UNION ALL SELECT 'activity_segments '||count(*) FROM activity_segments
  UNION ALL SELECT 'subscriptions '||count(*) FROM subscriptions
" 2>/dev/null | tr -d '\r' > /tmp/mdt-counts-now.txt
if [ -f "$BK/pre-v1.2-counts.txt" ]; then
  paste -d'|' <(sort "$BK/pre-v1.2-counts.txt") <(sort /tmp/mdt-counts-now.txt) \
    | awk -F'|' '{printf "    %-32s %s\n", $1, $2}'
  if diff -q <(sort "$BK/pre-v1.2-counts.txt") <(sort /tmp/mdt-counts-now.txt) >/dev/null; then
    ok "row counts identical"
  else
    # Counts can legitimately grow: agents keep uploading throughout. A count
    # going DOWN is the thing that is never acceptable.
    bad "row counts differ — check whether any went DOWN (growth is normal)"
  fi
else
  sed 's/^/    /' /tmp/mdt-counts-now.txt
fi

echo
echo "== Screenshot files still reachable ========================"
$DC exec -T api sh -c 'ls /data/storage | head -3; echo "  entries: $(ls /data/storage | wc -l)"' 2>/dev/null | sed 's/^/  /'

echo
echo "== New in 1.2 =============================================="
a=$(curl -so /dev/null -w '%{http_code}' -m 10 http://localhost:4200/api/v1/admin/agent/bundles)
[ "$a" = 401 ] && ok "agent download endpoint live (401 = exists, needs auth)" \
                || bad "agent endpoint returned $a (404 = still 1.1)"
p=$(curl -so /dev/null -w '%{http_code}' -m 10 http://localhost:4200/api/v1/platform/plans)
[ "$p" = 401 ] && ok "plans endpoint live" || bad "plans endpoint returned $p"

echo "  plans seeded in the database:"
# No quoting in the SQL at all: -A gives unaligned, pipe-separated columns.
# That sidesteps the fact that double quotes are identifiers in PostgreSQL and
# not strings — the first version of this line asked for a column named '  ('.
$DC exec -T db psql -U sentinel -d sentinel -tAc \
  "SELECT id, name FROM plans ORDER BY sort_order" 2>/dev/null \
  | tr -d '\r' | sed 's/^/    /'

echo "  agent bundles visible to the API:"
$DC exec -T api sh -c 'ls -l /data/agent 2>/dev/null || echo "(directory empty or not mounted)"' \
  | sed 's/^/    /'

echo
echo "== Rollback is still available ============================="
for t in mydesktime-api:1.1 mydesktime-console:1.1; do
  docker image inspect "$t" >/dev/null 2>&1 && ok "$t retained" || bad "$t gone"
done
ls -1 "$BK"/pre-v1.2-*.sql 2>/dev/null | tail -1 | sed 's/^/  backup: /'

echo
echo "============================================================"
if [ "$fail" -ne 0 ]; then
  printf '\033[31mSomething is wrong. bash 99-rollback.sh returns you to 1.1.\033[0m\n'
  exit 1
fi
printf '\033[32mv1.2 verified live and nothing lost.\033[0m\n'
echo
echo "Finally, check by hand in the browser:"
echo "  http://103.59.180.126:4200  -> Employees -> Set up on any row"
echo "     expect the bundle listed at 19.9 MB with a SHA-256"
echo "  http://103.59.180.126:4200/platform  -> Plans"
echo "     expect three plans, with Add plan and Edit"
echo "  Employees -> a name -> Edit employee -> change Team -> Save"
echo "     expect a clean save (this is the 500 that was fixed)"
