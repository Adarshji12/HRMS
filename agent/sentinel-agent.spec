# PyInstaller spec for the MyDeskTime desktop agent.
#
#   pip install pyinstaller
#   pyinstaller sentinel-agent.spec --noconfirm
#
# Produces, per platform:
#   Windows  dist/sentinel-agent/sentinel-agent.exe
#   Linux    dist/sentinel-agent/sentinel-agent
#   macOS    dist/Sentinel Agent.app  (plus the onedir bundle beside it)
#
# PyInstaller does NOT cross-compile. Each of the three has to be built on that
# operating system — see scripts/ and .github/workflows/agent-build.yml, which
# runs all three on their own runners.
#
# Onedir rather than onefile: a onefile build unpacks to a temp directory on
# every launch, which anti-virus products treat as suspicious and which makes
# the agent slow to start on cold boot.

import sys

block_cipher = None

# Both trackers for the *other* platforms are listed too. They are imported
# through a platform switch that PyInstaller cannot follow, and shipping the
# unused two costs a few KB against the risk of the switch finding nothing.
hidden = [
    # --selftest imports this lazily, so nothing statically references it.
    'agent.selftest',
    'agent.trackers.windows',
    'agent.trackers.macos',
    'agent.trackers.linux',
]

# Every platform dependency in this agent is imported lazily, INSIDE the
# function that needs it — deliberately, so enrolment works on a headless box
# with no display libraries. The cost is that static analysis sees none of
# them, so each one has to be named here or the packaged build fails at
# runtime with an ImportError that never appears in development.
if sys.platform == 'win32':
    hidden += [
        # comtypes generates its UI Automation wrapper at runtime.
        'comtypes', 'comtypes.client', 'comtypes.stream',
        'win32timezone',
    ]
elif sys.platform == 'darwin':
    hidden += [
        'AppKit', 'Quartz', 'Foundation', 'objc',
        'ApplicationServices',
        'mss.darwin',
    ]
else:
    hidden += [
        'Xlib', 'Xlib.display', 'Xlib.X', 'Xlib.protocol', 'Xlib.xobject',
        'Xlib.ext', 'Xlib.support.unix_connect',
        'mss.linux',
    ]

# pystray chooses its backend at runtime from an environment variable and a
# series of probes (see pystray.backend()), so none of these are reachable
# statically. Miss them and the tray icon simply never appears — with no error,
# because the agent treats pystray as optional. On a monitoring product the
# tray IS the disclosure to the person being monitored, so a silent failure
# here is a compliance problem, not a cosmetic one.
if sys.platform == 'win32':
    hidden += ['pystray._win32']
elif sys.platform == 'darwin':
    hidden += ['pystray._darwin']
else:
    hidden += ['pystray._xorg', 'pystray._appindicator', 'pystray._gtk']

a = Analysis(
    ['agent/main.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'pydoc', 'test'],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='sentinel-agent',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX-packed binaries trip several AV engines
    console=False,      # no console window; the tray icon is the visible surface
    disable_windowed_traceback=False,
    # Apple Silicon and Intel Macs need separate builds unless the runner has a
    # universal Python. None means "whatever this interpreter is", which is the
    # honest default; set SENTINEL_TARGET_ARCH=universal2 on a universal build.
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# The installer, and the only thing an employee opens. Windows only.
#
# The tracker above is windowed so nothing flashes on the desktop at every
# sign-in. That leaves it with no console, and getpass on Windows opens CONIN$
# rather than sys.stdin, so `--login` from the windowed build blocks forever on
# a handle no keystroke can ever reach — measured, not assumed. This console
# twin runs the same entry point with a terminal attached, which is all
# enrolment and --status ever needed.
#
# macOS and Linux need no equivalent: `console` is a Windows-only flag, and the
# binary inside the .app runs from Terminal with working stdio.
extra = []

if sys.platform == 'win32':
    extra.append(EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='MyDeskTime-Setup',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        disable_windowed_traceback=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
    ))

coll = COLLECT(
    exe,
    *extra,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='sentinel-agent',
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='Sentinel Agent.app',
        bundle_identifier='com.mydesktime.agent',
        info_plist={
            'LSUIElement': True,          # menu-bar app, no Dock icon
            'NSHighResolutionCapable': True,
            'CFBundleShortVersionString': '0.1.0',
            # macOS shows these strings in the permission prompts. They are what
            # the employee reads when deciding to grant access, so keep them
            # accurate rather than generic.
            'NSAppleEventsUsageDescription':
                'MyDeskTime reads the active browser tab URL to categorise work time.',
            # Screen Recording and Accessibility are granted through System
            # Settings rather than a prompt string, but the description is shown
            # in the pane's list, so it still has to say something true.
            'NSDesktopFolderUsageDescription':
                'MyDeskTime captures periodic screenshots of the desktop.',
        },
    )
