#!/bin/zsh
# install.sh -- install/uninstall the com.iqalgo.minute-worker LaunchAgent.
#
#   ./install.sh              install (or reinstall) and start the agent
#   ./install.sh --uninstall  stop the agent and remove the plist
#   ./install.sh --status     show whether the agent is loaded/running
#
# The plist ships with empty SUPABASE_URL / SUPABASE_SERVICE_KEY, which means
# local-only mode. Edit com.iqalgo.minute-worker.plist to fill them in, then
# re-run ./install.sh -- launchd only reads EnvironmentVariables at bootstrap.

set -euo pipefail

LABEL="com.iqalgo.minute-worker"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$HERE/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-install}" in
  --uninstall|uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "Uninstalled $LABEL."
    ;;

  --status|status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E 'state|pid|last exit' || true
    else
      echo "$LABEL is not loaded."
    fi
    ;;

  install|--install)
    [[ -f "$PLIST_SRC" ]] || { echo "Missing $PLIST_SRC" >&2; exit 1; }
    mkdir -p "$HERE/logs" "$HOME/Library/LaunchAgents"

    # Reinstall-safe: unload any previous copy first (ignore "not loaded").
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

    cp "$PLIST_SRC" "$PLIST_DST"

    # Secret injection: SUPABASE_SERVICE_KEY in the environment at install
    # time is written into the INSTALLED plist copy only — the repo copy
    # stays empty so the key can never be committed. URL defaults to the
    # trend-iq site project.
    if [[ -n "${MINUTE_INGEST_TOKEN:-}" ]]; then
      INGEST_URL="${MINUTE_INGEST_URL:-https://zuhpyynilcqfgufexgli.supabase.co/functions/v1/ingest-minute}"
      /usr/bin/python3 - "$PLIST_DST" "$INGEST_URL" "$MINUTE_INGEST_TOKEN" <<'PY'
import sys
path, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(path).read()
t = t.replace("<key>MINUTE_INGEST_URL</key>\n        <string></string>",
              "<key>MINUTE_INGEST_URL</key>\n        <string>%s</string>" % url)
t = t.replace("<key>MINUTE_INGEST_TOKEN</key>\n        <string></string>",
              "<key>MINUTE_INGEST_TOKEN</key>\n        <string>%s</string>" % token)
open(path, "w").write(t)
print("Ingest sync enabled in installed plist (repo copy untouched).")
PY
    elif [[ -n "${SUPABASE_SERVICE_KEY:-}" ]]; then
      SUPA_URL="${SUPABASE_URL:-https://zuhpyynilcqfgufexgli.supabase.co}"
      /usr/bin/python3 - "$PLIST_DST" "$SUPA_URL" "$SUPABASE_SERVICE_KEY" <<'PY'
import sys
path, url, key = sys.argv[1], sys.argv[2], sys.argv[3]
t = open(path).read()
t = t.replace("<key>SUPABASE_URL</key>\n        <string></string>",
              "<key>SUPABASE_URL</key>\n        <string>%s</string>" % url)
t = t.replace("<key>SUPABASE_SERVICE_KEY</key>\n        <string></string>",
              "<key>SUPABASE_SERVICE_KEY</key>\n        <string>%s</string>" % key)
open(path, "w").write(t)
print("Supabase sync enabled in installed plist (repo copy untouched).")
PY
    else
      echo "SUPABASE_SERVICE_KEY not set -> local-only mode (no Supabase sync)."
    fi

    launchctl bootstrap "$DOMAIN" "$PLIST_DST"
    launchctl kickstart -k "$DOMAIN/$LABEL"

    echo "Installed and started $LABEL."
    echo "Logs: $HERE/logs/minute-worker.{out,err}.log"
    ;;

  *)
    echo "Usage: $0 [install|--uninstall|--status]" >&2
    exit 1
    ;;
esac
