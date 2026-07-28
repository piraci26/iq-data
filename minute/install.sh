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
