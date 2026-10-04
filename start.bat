@echo off
REM DevSpace 4.0 Windows Startup Script
cd /d "%~dp0"
echo Starting DevSpace 4.0 on Port 7980...
pnpm tsx src/cli.ts
