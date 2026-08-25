#!/usr/bin/env bash
# Build the MyDeskTime agent for whichever platform this is running on.
#
#   ./scripts/build.sh            build
#   ./scripts/build.sh --check    build, then run the self-test against the
#                                 packaged binary rather than the source tree
#
# PyInstaller does not cross-compile: run this on a Mac to get the .app, on
# Linux to get the Linux binary. .github/workflows/agent-build.yml does all
# three on their own runners so no one needs three machines.
set -euo pipefail

cd "$(dirname "$0")/.."
CHECK=${1:-}

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *) echo "Use scripts/build.ps1 on Windows." >&2; exit 1 ;;
esac

# Build against a clean interpreter. A venv that has been used for development
# drags whatever was ever pip-installed into the bundle, and the difference
# only shows up as a 40 MB artifact nobody can explain.
python3 -m venv .venv-build
# shellcheck disable=SC1091
source .venv-build/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r requirements.txt pyinstaller==6.11.1

if [ "$OS" = linux ]; then
  # python-xlib is pure Python, but pystray's X11 backend needs the actual
  # libraries at runtime, and PyInstaller only bundles what it can find at
  # build time. Missing them costs the tray icon — which on a monitoring
  # product is the disclosure to the person being monitored, not decoration.
  for lib in libX11.so.6 libXss.so.1 libgirepository-1.0.so.1; do
    ldconfig -p | grep -q "$lib" || echo "warning: $lib not found; tray or idle detection may not work" >&2
  done
fi

rm -rf build dist
pyinstaller sentinel-agent.spec --noconfirm --clean

if [ "$OS" = macos ]; then
  BIN="dist/Sentinel Agent.app/Contents/MacOS/sentinel-agent"
  OUT="dist/mydesktime-agent-macos-$(uname -m).zip"
  # The bare .app is not shippable on its own: somebody still has to enrol it
  # and load the LaunchAgent, so the installer travels with it.
  rm -rf dist/stage && mkdir -p dist/stage
  cp -a "dist/Sentinel Agent.app" dist/stage/
  cp packaging/macos/com.mydesktime.agent.plist packaging/macos/install.sh dist/stage/
  chmod +x dist/stage/install.sh
  # ditto, not zip: it is the only archiver that preserves the bundle's
  # symlinks and extended attributes, and a .app that loses them is refused by
  # Gatekeeper on the far side with a signature error that reads like a
  # signing problem rather than a packaging one.
  ( cd dist/stage && ditto -c -k --keepParent . "../$(basename "$OUT")" )
else
  BIN="dist/sentinel-agent/sentinel-agent"
  OUT="dist/mydesktime-agent-linux-$(uname -m).tar.gz"
  cp packaging/linux/mydesktime-agent.service packaging/linux/install.sh dist/sentinel-agent/
  chmod +x dist/sentinel-agent/install.sh
  tar -czf "$OUT" -C dist sentinel-agent
fi

echo
echo "built: $OUT"

# Proof the bundle runs, not just that PyInstaller exited 0. --status touches
# the config, the spool and the platform name, so an import missed by the spec
# surfaces here instead of on an employee's laptop.
"$BIN" --status || true

if [ "$CHECK" = --check ]; then
  echo
  echo "--- capability self-test, run through the packaged bundle ---"
  # Through the bundle, not `python -m agent.selftest`: the point is to prove
  # the shipped artifact can reach the platform APIs. The source tree can do
  # that while the bundle cannot, and that gap is exactly the failure mode
  # PyInstaller produces. Enrols nothing, contacts no server, writes no files.
  "$BIN" --selftest
fi

deactivate
