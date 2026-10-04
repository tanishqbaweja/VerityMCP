@echo off
title DevSpace 4.0 (Verified Computer Engineering Architecture)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo DevSpace 4.0 stopped with exit code %ERRORLEVEL%.
    pause
)
