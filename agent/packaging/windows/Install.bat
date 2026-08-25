@echo off
REM Double-clickable installer.
REM
REM Employees should not be asked to open PowerShell and type a command with
REM flags. Worse, Windows blocks .ps1 files that arrived inside a downloaded
REM zip, so "Run with PowerShell" fails on most machines with a security error
REM that reads like the software is broken. A .bat has no such restriction and
REM can call PowerShell with the bypass itself.

title MyDeskTime Setup
color 0F
cls

echo.
echo   ============================================================
echo     MyDeskTime - one-time setup
echo   ============================================================
echo.
echo   This links this computer to your account. It takes about
echo   thirty seconds and only needs doing once.
echo.

REM Edited per deployment so the employee never has to type a URL.
set "SERVER=http://103.59.180.126:4200"

echo   Server: %SERVER%
echo.
set /p "KEY=  Enter the enrolment key from your administrator: "

if "%KEY%"=="" (
    echo.
    echo   No key entered. Nothing has been changed.
    echo.
    pause
    exit /b 1
)

echo.
echo   Installing...
echo.

REM -ExecutionPolicy Bypass is the point of this file: without it Windows
REM refuses to run a script that came from a downloaded archive.
REM %~dp0 is this file's own folder, so it works wherever the zip was opened.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -EnrollKey "%KEY%" -Server "%SERVER%"

if errorlevel 1 (
    echo.
    echo   ------------------------------------------------------------
    echo     Setup did not complete. Show this window to your
    echo     administrator - the reason is printed above.
    echo   ------------------------------------------------------------
) else (
    echo.
    echo   ------------------------------------------------------------
    echo     Done. MyDeskTime will start automatically each time you
    echo     sign in. Look for its icon near the clock.
    echo   ------------------------------------------------------------
)

echo.
pause
