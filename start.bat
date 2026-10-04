@echo off
title VerityMCP (Verified Local Computer Engineering Layer)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo VerityMCP stopped with exit code %ERRORLEVEL%.
    pause
)
