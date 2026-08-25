#!/usr/bin/env bash
# Install the MyDeskTime agent for the current user.
#
#   ./install.sh --login you@company.com --org acme --server https://mydesktime.example.com
#   ./install.sh --enroll ABCD-EFGH-IJKL-MNOP --server https://mydesktime.example.com
#
# Everything here is per-user and needs no root: the agent reads the X11
# session, which root cannot see anyway, and asking employees for sudo to
# install monitoring is a conversation nobody wants to have.
set -euo pipefail

TARGET="$HOME/.local/share/mydesktime"
UNIT="$HOME/.config/systemd/user/mydesktime-agent.service"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -eq 0 ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
  echo "This session is Wayland, which does not let one program read another's" >&2
  echo "window. The agent will enrol and heartbeat but collect nothing. Log in" >&2
  echo "with an X11/Xorg session instead." >&2
  echo >&2
fi

mkdir -p "$TARGET" "$(dirname "$UNIT")"

if [ "$HERE" != "$TARGET" ]; then
  # Replace the payload wholesale rather than copying over it, so an upgrade
  # cannot leave a stale shared library behind for the new binary to load.
  # Skipped when this script is already running *from* the install directory —
  # a re-run to change the enrolment should not delete itself mid-execution.
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -a "$HERE"/. "$TARGET"/
fi
chmod +x "$TARGET/sentinel-agent"

# Enrol before installing the unit. A service that starts unenrolled just logs
# the same refusal every fifteen seconds, and whoever set it up has already
# walked away by then.
"$TARGET/sentinel-agent" "$@"

install -m 644 "$HERE/mydesktime-agent.service" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now mydesktime-agent.service

# Without this the unit stops the moment the person logs out and does not come
# back until the next graphical login — which on a laptop that suspends rather
# than shuts down can be weeks.
loginctl enable-linger "$USER" 2>/dev/null || \
  echo "note: could not enable linger; the agent will only run while you are logged in" >&2

echo
systemctl --user --no-pager status mydesktime-agent.service | head -5
