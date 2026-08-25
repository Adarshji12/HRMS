# MyDeskTime desktop agent

Cross-platform activity agent. Samples the foreground window once per second,
collapses runs into segments, captures screenshots on a schedule, spools
everything locally, and uploads in batches.

```
# Employee signs in with their own dashboard credentials
python -m agent.main --login priya@acme.com --org acme --server https://mydesktime.example.com

# Or an admin binds the machine with a one-off enrollment key
python -m agent.main --enroll ABCD-EFGH-IJKL-MNOP --org acme --server https://...

python -m agent.main            # run
python -m agent.main --status   # binding, cached policy, queue depth
python -m agent.main --once     # one sample + one sync, then exit
```

Both paths do the same thing: trade a credential for a **device token**, once.
The password is read with `getpass` (never echoed, never in shell history), sent
in a single request, and never written to disk — only the token is. So a stolen
laptop yields a credential an admin can revoke from the dashboard, not the
employee's password.

`--login` needs `--org` because an email address is only unique *within* one
company; an enrollment key is globally unique and identifies its own workspace.

## Local state

| Path | Contents |
|---|---|
| Windows | `%LOCALAPPDATA%\Sentinel\` |
| macOS | `~/Library/Application Support/Sentinel/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Sentinel/` |

- `agent.json` — server URL, device token, machine id, cached policy
- `spool.db` — SQLite queue of unsent segments and screenshot metadata
- `pending/*.jpg` — screenshot bytes awaiting upload
- `agent.log` — rotating log, 2 MB × 4

The device token is the machine's credential. Only its SHA-256 digest is stored
server-side, so a database leak yields no working agent credentials.

## Platform support

| | Foreground app | Window title | Idle | Browser URL | Screenshots |
|---|---|---|---|---|---|
| Windows | ✅ user32 | ✅ | ✅ `GetLastInputInfo` | ✅ UI Automation | ✅ mss |
| macOS | ✅ NSWorkspace | ⚠️ needs Screen Recording | ✅ CGEventSource | ⚠️ needs Accessibility (AppleScript) | ⚠️ needs Screen Recording |
| Linux (X11) | ✅ Xlib | ✅ | ✅ XScreenSaver | ❌ title heuristics only | ✅ mss |
| Linux (Wayland) | ❌ | ❌ | ❌ | ❌ | ❌ refused, not blank |

The Windows path is tested end-to-end. The macOS and Linux trackers are written
against their platform APIs but have **not** been run on real hardware.

**Validate them in one command** on a Mac or Linux box:

```bash
python -m agent.selftest
```

It exercises the tracker and reports which capabilities actually work —
dependencies, foreground app, window title, idle, input tick, lock state,
browser URL, screen capture and git context. It enrols nothing, contacts no
server, uploads no screenshots and writes no files, so it is safe to run on a
machine that is not yours to configure.

`PASS`/`FAIL` are defects. `WARN` lines are context-dependent (no browser
focused, no editor focused) and usually mean "rerun with that window in front".

On macOS the expected first-run failures are permission ones: an empty window
title means Screen Recording is not granted, and a missing browser URL means
Accessibility is not. Both are System Settings toggles, ideally pre-approved by
MDM.

**Wayland** deliberately denies clients access to other windows. `LinuxTracker`
raises on construction there, and the agent degrades to a null tracker (it still
enrols and heartbeats, so the machine shows up in the dashboard rather than
silently vanishing). A real Wayland implementation needs a GNOME Shell extension
or KWin script plus the `xdg-desktop-portal` screencast API.

## When capture cannot work

Two situations let this agent run perfectly while collecting nothing, and both
used to be invisible — screenshots arrived on schedule and every one was blank:

- **Wayland.** `mss` still connects through XWayland and still returns a frame.
  Wayland just will not put another client's pixels in it, so the frame is black.
- **macOS without Screen Recording.** macOS does not raise; it returns the
  desktop wallpaper with every window removed. A detailed image of nothing.

Neither is detectable from the image — a wallpaper is not blank, and a dark
screen is not proof of anything. So both are checked directly, in
`screenshots.capture_blocker()`: the session type for Wayland,
`CGPreflightScreenCaptureAccess()` for macOS. When either says no, `capture()`
refuses **before** grabbing anything.

A skipped capture leaves a gap someone can ask about. A black one does not.

The reason then travels four ways, because whoever needs it could be anywhere:

| Where | What they see |
|---|---|
| `agent.log` | `SCREENSHOTS DISABLED: <reason>` at startup |
| Tray icon | tooltip and a notification — the employee is told too |
| `--status` | `Screenshots: BLOCKED - <reason>` |
| Dashboard | an amber line under the device, from the heartbeat |

On macOS the agent also *asks* for Screen Recording at startup. macOS only ever
shows that prompt on an explicit request and only once, so never asking means
the answer stays no forever.

`--selftest` checks the same thing, then looks at the pixels as a backstop for
causes neither check knows about. The old test was `len(data) > 0`, which passes
on every failure this file exists to catch — a blank JPEG is still a few hundred
valid bytes.

**Browser URLs** are read from the address bar via UI Automation on Windows and
AppleScript on macOS, with window-title heuristics as the fallback everywhere.
Title parsing is genuinely unreliable — it only fires on an explicit hostname in
the title or a small list of unambiguous site names, because a wrong domain is
worse than no domain. For production accuracy, ship the companion browser
extension; it can post to the same `/api/v1/agent/activity` endpoint.

## Building installers

PyInstaller does not cross-compile. The bootloader and every native dependency
are baked in for the platform doing the build, so each of the three artifacts
has to be produced on its own operating system. There is no flag for this and
no container trick that works for macOS.

```bash
./scripts/build.sh            # macOS or Linux
./scripts/build.sh --check    # ...and run the capability self-test on the bundle
```
```powershell
.\scripts\build.ps1           # Windows
.\scripts\build.ps1 -Check    # ...and run the capability self-test on the bundle
```

`.github/workflows/agent-build.yml` builds all four on their own runners —
Windows x64, Linux x64, macOS arm64 and macOS x64 — so nobody needs three
machines. Push a tag matching `agent-v*` and it attaches them to a release.

Each build smoke-tests its own bundle before packaging it. PyInstaller exiting
0 only proves it wrote files; every import the spec failed to find is still an
ImportError waiting on an employee's laptop, and this agent imports every
platform dependency lazily *inside* the function that needs it, so static
analysis finds none of them by itself.

| | Artifact | Autostart | Installer |
|---|---|---|---|
| Windows | `sentinel-agent.exe` + `sentinel-setup.exe` | Scheduled task, at logon | `packaging/windows/install.ps1` |
| macOS | `Sentinel Agent.app` | LaunchAgent | `packaging/macos/install.sh` |
| Linux | `sentinel-agent` | systemd **user** unit | `packaging/linux/install.sh` |

All three installers are per-user and need no administrator rights. That is not
a convenience: the foreground window, the idle timer and — on macOS — every
relevant permission are per-session and per-user, so a service running as root
or SYSTEM cannot see any of them however it is privileged.

### Two binaries on Windows

`sentinel-agent.exe` is windowed, so nothing flashes on the desktop at every
sign-in. Windows gives a windowed process no console, and `getpass` there does
not fall back to stdin — it opens `CONIN$` directly and blocks forever on a
handle no keystroke can reach. A double-clicked enrolment used to hang
invisibly: no prompt, no error, no exit.

So enrolment and `--status` live in `sentinel-setup.exe`, a console build of the
same entry point. The windowed binary now checks before prompting and says
where to go instead of hanging.

macOS and Linux need no equivalent — `console` is a Windows-only flag, and the
binary inside the `.app` has working stdio when run from Terminal.

### Checking a machine before trusting its data

The Windows path is tested end to end. The macOS and Linux trackers are written
against their platform APIs but have never run on real hardware, and both
depend on permissions granted per machine. Ask the bundle itself:

```bash
"/Applications/Sentinel Agent.app/Contents/MacOS/sentinel-agent" --selftest
~/.local/share/mydesktime/sentinel-agent --selftest
```
```powershell
& "$env:LOCALAPPDATA\Programs\MyDeskTime\sentinel-setup.exe" --selftest
```

`PASS`/`FAIL` are defects. `WARN` is context — no browser focused, no editor
focused — and usually means rerun with that window in front. On macOS the
expected first-run failures are permission ones: an empty window title means
Screen Recording is not granted, a missing browser URL means Accessibility is
not.

### Signing

Nothing in CI is signed, and unsigned is not a cosmetic problem for a
monitoring agent — it is the difference between an install that works and one
every employee is warned away from.

- **Windows** — Authenticode-sign both EXEs. Unsigned, SmartScreen blocks them
  and the dialog says the publisher is unknown.
- **macOS** — `codesign --deep --options runtime`, then `notarytool submit` and
  `stapler staple`. Without notarisation Gatekeeper refuses to open the app at
  all; the only way past is right-click → Open, on every machine. Pre-approve
  Screen Recording and Accessibility with an MDM PPPC profile — it is the only
  way to avoid asking every employee, and the only way the answer is reliably
  yes.
- **Linux** — nothing to sign. Ship the tarball, or repackage as `.deb`/`.rpm`
  around the same systemd user unit.

### Wayland

`LinuxTracker` raises on construction under Wayland, which deliberately denies
one client access to another's window, and the agent degrades to a null tracker
— it still enrols and heartbeats, so the machine appears in the dashboard
rather than silently vanishing. `packaging/linux/install.sh` warns at install
time rather than letting someone discover it from an empty report a week later.
A real implementation needs a GNOME Shell extension or KWin script plus the
`xdg-desktop-portal` screencast API.

## Behaviour worth knowing

**Offline.** Segments go to the SQLite spool before anything else and are deleted
only after the server acknowledges them. A laptop can be offline for days and
backfill on reconnect; the ingest endpoint is idempotent on `client_uid`, so a
retry after a half-failed upload does not double-count time. The spool self-trims
at 200k segments / 5k screenshots / 30 days, oldest first, and drops any single
row the server has rejected 20 times so a poison row cannot block the queue.

**Policy.** Every heartbeat returns the org policy and the agent applies it live —
interval, quality, idle threshold, URL/title capture, working hours. No redeploy
is needed to change what is collected.

**Revocation.** If an admin disables the device, the next heartbeat returns
`revoked`, and the agent stops *and wipes its local spool* rather than sitting on
data it may no longer hold.

**Working hours.** With `track_outside_hours` off (the default) the agent samples
nothing outside the configured window — no segments, no screenshots.

**Screenshot timing.** With randomisation on, the capture fires at an
unpredictable moment inside each interval window. The number of captures per hour
is identical either way, so the setting does not quietly increase how much is
collected — it only stops the schedule being trivially dodged.

**What is never captured:** keystroke content, clipboard contents, file contents,
microphone or camera. Idle detection reads only *time since last input*, never
which keys.
