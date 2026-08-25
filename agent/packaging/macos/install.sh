#!/usr/bin/env bash
# Install the MyDeskTime agent for the current user.
#
#   ./install.sh --login you@company.com --org acme --server https://mydesktime.example.com
#   ./install.sh --enroll ABCD-EFGH-IJKL-MNOP --server https://mydesktime.example.com
#
# Run it from the folder holding "Sentinel Agent.app". Per-user throughout, so
# no sudo: the permissions the agent needs are per-user anyway and root cannot
# hold them on someone else's behalf.
set -euo pipefail

APP="Sentinel Agent.app"
DEST="$HOME/Applications"
PLIST="$HOME/Library/LaunchAgents/com.mydesktime.agent.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -eq 0 ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

[ -d "$HERE/$APP" ] || { echo "$APP not found beside this script." >&2; exit 1; }

mkdir -p "$DEST" "$(dirname "$PLIST")"
rm -rf "$DEST/$APP"
# ditto rather than cp: it is the only copier that keeps the bundle's symlinks
# and extended attributes intact, and a bundle that loses them is rejected by
# Gatekeeper with a signature error that looks nothing like a copy problem.
ditto "$HERE/$APP" "$DEST/$APP"

BIN="$DEST/$APP/Contents/MacOS/sentinel-agent"

# Enrol first. A LaunchAgent that starts unenrolled logs the same refusal every
# fifteen seconds, long after whoever installed it has walked away.
"$BIN" "$@"

# The plist ships pointing at /Applications; this installs per-user, so rewrite
# the one path rather than shipping two nearly identical plists.
sed "s|/Applications/$APP|$DEST/$APP|" "$HERE/com.mydesktime.agent.plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/com.mydesktime.agent" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat <<'NOTE'

Two permissions still have to be granted by hand, in System Settings →
Privacy & Security. macOS will not prompt for either one, and until they are
granted the agent runs and reports in while collecting almost nothing:

  Screen Recording  — window titles and screenshots
  Accessibility     — the browser URL

Grant both to "Sentinel Agent", then confirm what actually works:

  "$HOME/Applications/Sentinel Agent.app/Contents/MacOS/sentinel-agent" --selftest

On a managed fleet, pre-approve both with an MDM PPPC profile instead. That is
the only way to avoid every employee being asked, and the only way the answer
is reliably yes.
NOTE
