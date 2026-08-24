#!/bin/bash
# Export MariaDB → SQLite snapshot and redeploy ct-upm-mcp to Fly.io.
# Invoked by com.keogh.upm-export-deploy (Mondays 5:00 AM ET, after the Sunday
# court + hearings scrapes). Safe to run manually.
set -euo pipefail
cd "$(dirname "$0")"

# Hold off idle sleep for the whole run. pmset shows the 8/24/26 run started at
# 00:09:31 — the exact second of a "DarkWake from Deep Idle ... rtc/SleepService"
# — because launchd fires this job on wake, and the Mac spent that night on
# battery cycling maintenance sleep. A DarkWake throttles the network and is
# actively trying to get back to sleep, which is why a ~194 MB upload sat there
# for 69 minutes and then timed out rather than failing fast. Re-exec under
# caffeinate so the machine stays awake until the deploy is done; the env var
# stops the re-exec from recursing.
if [ -z "${UPM_DEPLOY_CAFFEINATED:-}" ] && [ -x /usr/bin/caffeinate ]; then
  export UPM_DEPLOY_CAFFEINATED=1
  exec /usr/bin/caffeinate -i -m -s "$0" "$@"
fi

# Any failure (export, sanity gate, fly deploy, health check) → email alert.
# The 7/20/26 deploy failed silently on an expired fly token and nobody knew
# until a 7/22 review compared live stats against local. Never again.
on_failure() {
  /opt/homebrew/bin/node "$HOME/mcp-servers/scripts/send-felix-alert.js" \
    "🔴 FELIX ALERT: UPM export-and-deploy FAILED" \
    "The Monday ct-upm-mcp export/deploy (com.keogh.upm-export-deploy) failed on $(date '+%m/%d/%Y %H:%M ET') — the Fly server is still serving the PREVIOUS snapshot.

Last log lines:
$(tail -25 "$HOME/felix-logs/upm-export-deploy-launchd.log" 2>/dev/null)
$(tail -10 "$HOME/felix-logs/upm-export-deploy-launchd-error.log" 2>/dev/null)

Logs: ~/felix-logs/upm-export-deploy-launchd*.log
Manual retry: cd ~/mcp-servers/ct-upm-remote && ./export-and-deploy.sh" || true
}
trap 'on_failure' ERR

# Deliberate aborts must go through fail(), never a bare `exit 1`: bash does NOT
# run an ERR trap for `exit`, so every hand-written `exit 1` below was aborting
# SILENTLY — the sanity gate and the health check both. Only a command that
# failed on its own (e.g. `fly deploy`) ever reached on_failure. Found 8/24/26
# while adding the deploy retry; it defeated the whole point of the trap.
fail() {
  trap - ERR
  echo "$1"
  on_failure
  exit 1
}

# Fly auth: use the durable deploy token from ~/.env (FLY_API_TOKEN, created
# 7/22/26). Interactive `fly auth login` tokens expire and a 5 AM launchd job
# cannot re-login — that failure mode shipped nothing on 7/20/26 and surfaced
# only by accident. Token is app-scoped to ct-upm-mcp.
if [ -f "$HOME/.env" ]; then
  FLY_API_TOKEN=$(grep -E '^FLY_API_TOKEN=' "$HOME/.env" | head -1 | cut -d= -f2- | tr -d '"')
  if [ -n "${FLY_API_TOKEN:-}" ]; then
    export FLY_API_TOKEN
  else
    echo "WARN: no FLY_API_TOKEN in ~/.env — falling back to interactive fly login (may be expired)"
  fi
fi

echo ""
echo "=== Export & deploy: $(date '+%Y-%m-%d %H:%M:%S') ==="

# Network preflight — same lib/network-ready guard the node daemons use (18f14ec,
# 11c710f), reached from bash. launchd fires a missed 5 AM job the moment the Mac
# wakes, typically before Wi-Fi has reassociated: the 8/17/26 run died on
# "lookup api.machines.dev: no such host" and could not even send its own failure
# alert ("send-felix-alert: FAILED to send: fetch failed"), so that run was
# completely silent. All three hosts verified to resolve before being gated —
# a host that never resolves would skip the run forever. flyctl-metrics.fly.dev
# is deliberately NOT gated: it only ever produces a warning.
if ! /opt/homebrew/bin/node -e '
  const { awaitNetwork } = require(process.env.HOME + "/mcp-servers/lib/network-ready");
  awaitNetwork(["api.machines.dev", "registry.fly.io", "api.fly.io"], { label: "upm-export-deploy" })
    .then(ok => process.exit(ok ? 0 : 1));
'; then
  echo "Network never came up — skipping this run; launchd fires again next Monday."
  exit 0
fi

# Non-fatal sentinel: alert if DSS resumes posting UPM transmittals (>2019).
"$HOME/mcp-servers/upm-scraper/check-new-transmittals.sh" || true

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
  fail "ABORT: implausible snapshot counts — not deploying"
fi

mv "$NEW_DB" data/ct-upm.db
rm -f data/ct-upm.db-shm data/ct-upm.db-wal "$NEW_DB-shm" "$NEW_DB-wal"

# Compress the snapshot for upload: the Dockerfile copies ONLY data/ct-upm.db.gz
# and gunzips it in a throwaway stage, which is what keeps the build context at
# ~68 MB instead of ~194 MB. Written to a temp name and moved into place so an
# interrupted gzip can never leave a truncated .gz that would deploy a corrupt
# database. Keep the plain .db too — it is the source for next week's diff and
# for local inspection; .dockerignore keeps it out of the upload.
echo "Compressing snapshot for upload..."
rm -f data/ct-upm.db.gz.tmp
gzip -c data/ct-upm.db > data/ct-upm.db.gz.tmp
mv data/ct-upm.db.gz.tmp data/ct-upm.db.gz
echo "Build context snapshot: $(du -h data/ct-upm.db | cut -f1) → $(du -h data/ct-upm.db.gz | cut -f1) compressed"

# Retry the deploy. `fly deploy` is idempotent — it builds an image and does a
# rolling machine update, with no send or write to duplicate — so this is not the
# non-idempotent auto-retry the launchd playbook forbids. The 8/24/26 failure was
# a stalled upload of the ~200 MB build context: "read: operation timed out"
# partway through "load build context", which also poisoned the builder session
# and produced a wall of misleading "unauthenticated: Invalid token" lines. The
# token was fine — verified against the same token afterward. flyctl's own retry
# fired twice inside 17 minutes and hit the same stall; a longer gap between
# attempts is what was missing.
DEPLOY_OK=0
for attempt in 1 2 3; do
  echo "--- fly deploy attempt $attempt of 3 ---"
  if /opt/homebrew/bin/fly deploy --remote-only; then
    DEPLOY_OK=1
    break
  fi
  echo "Deploy attempt $attempt failed."
  if [ "$attempt" -lt 3 ]; then
    echo "Waiting 300s before retrying..."
    sleep 300
  fi
done
if [ "$DEPLOY_OK" -ne 1 ]; then
  fail "ABORT: fly deploy failed 3 times — Fly is still serving the previous snapshot"
fi

echo "--- post-deploy health check ---"
sleep 10
BODY=$(mktemp)
HTTP=$(curl -s -o "$BODY" -w "%{http_code}" --max-time 30 https://ct-upm-mcp.fly.dev/)
echo "Landing page HTTP $HTTP"
if [ "$HTTP" != "200" ]; then
  rm -f "$BODY"
  fail "ABORT: post-deploy health check returned HTTP $HTTP"
fi

# HTTP 200 alone does not prove the snapshot shipped. The landing page renders its
# counts live off the database (server.js builds them from sc.count/hc.count), so
# asserting the section count we just exported is what actually proves the new
# .db was decompressed into the image and opened. This matters more since the
# snapshot started travelling compressed — a truncated .gz is exactly the kind of
# failure a status-code-only check would wave through.
LIVE_SECTIONS=$(tr -d ',' < "$BODY" | grep -oE '>[0-9]+</span><span class="label">UPM Policy Sections' | grep -oE '[0-9]+' | head -1)
rm -f "$BODY"
echo "Live landing page reports sections=${LIVE_SECTIONS:-<none>} (expected $SECTIONS)"
if [ "${LIVE_SECTIONS:-}" != "$SECTIONS" ]; then
  fail "ABORT: deployed server reports sections=${LIVE_SECTIONS:-<none>}, expected $SECTIONS — the new snapshot did not ship"
fi

echo "=== Export & deploy complete: $(date '+%Y-%m-%d %H:%M:%S') ==="
