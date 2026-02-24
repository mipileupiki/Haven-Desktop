@echo off
title Haven Desktop
cd /d "%~dp0"

:: Quick check that setup has been run
if not exist "node_modules" (
    color 0C
    echo.
    echo  Haven Desktop has not been set up yet.
    echo  Please run "Setup.bat" first.
    echo.
    pause
    exit /b 1
)

:: Launch Electron in dev mode
echo Starting Haven Desktop...
node "./node_modules/electron/cli.js" . --dev
