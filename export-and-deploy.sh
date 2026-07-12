#!/bin/bash
# Export MariaDB → SQLite snapshot and redeploy ct-upm-mcp to Fly.io.
# Invoked by com.keogh.upm-export-deploy (Mondays 5:00 AM ET, after the Sunday
# court + hearings scrapes). Safe to run manually.
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "=== Export & deploy: $(date '+%Y-%m-%d %H:%M:%S') ==="

NEW_DB="data/ct-upm.db.new"
rm -f "$NEW_DB" "$NEW_DB-shm" "$NEW_DB-wal"
/opt/homebrew/bin/node export-to-sqlite.cjs "$NEW_DB"

# Sanity gate: never ship a snapshot with implausible row counts.
COUNTS=$(sqlite3 "$NEW_DB" "SELECT (SELECT COUNT(*) FROM sections) || '|' || (SELECT COUNT(*) FROM hearing_decisions) || '|' || (SELECT COUNT(*) FROM court_decisions) || '|' || (SELECT COUNT(*) FROM ct_statutes);")
SECTIONS=$(echo "$COUNTS" | cut -d'|' -f1)
HEARINGS=$(echo "$COUNTS" | cut -d'|' -f2)
COURTS=$(echo "$COUNTS" | cut -d'|' -f3)
STATUTES=$(echo "$COUNTS" | cut -d'|' -f4)
echo "Snapshot counts: sections=$SECTIONS hearings=$HEARINGS courts=$COURTS statutes=$STATUTES"
if [ "$SECTIONS" -lt 1600 ] || [ "$HEARINGS" -lt 4300 ] || [ "$COURTS" -lt 500 ] || [ "$STATUTES" -lt 2500 ]; then
  echo "ABORT: implausible snapshot counts — not deploying"
  exit 1
fi

mv "$NEW_DB" data/ct-upm.db
rm -f data/ct-upm.db-shm data/ct-upm.db-wal "$NEW_DB-shm" "$NEW_DB-wal"

/opt/homebrew/bin/fly deploy --remote-only

echo "--- post-deploy health check ---"
sleep 10
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 https://ct-upm-mcp.fly.dev/)
echo "Landing page HTTP $HTTP"
if [ "$HTTP" != "200" ]; then
  echo "WARN: health check returned $HTTP"
  exit 1
fi

echo "=== Export & deploy complete: $(date '+%Y-%m-%d %H:%M:%S') ==="
