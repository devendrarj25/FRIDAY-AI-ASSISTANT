@echo off
setlocal EnableExtensions
title FRIDAY - Windows build

REM FRIDAY - Personal AI Assistant
REM Publisher: Devendra Singh Meena (devendrarj25)
REM
REM Thin wrapper. The phase list lives in scripts\build-pipeline.cjs so the
REM CMD pack, FRIDAY Release, and FRIDAY Test Build cannot drift apart.
REM
REM Usage (from the FRIDAY project root, wherever it lives):
REM   scripts\build-windows.cmd            installer + portable
REM   scripts\build-windows.cmd nsis       installer only
REM   scripts\build-windows.cmd portable   portable only
REM   scripts\build-windows.cmd dir        unpacked folder only

pushd "%~dp0.." || (echo [FRIDAY] project folder could not be opened & exit /b 1)

REM A fresh PC has no Node.js. Prepare the Windows toolchain first (Node.js, Python,
REM Git, PowerShell through winget or the official downloads), then carry on. A PC
REM whose Node.js already meets the floor (22.19.0+) skips this and is not touched.
set "FRIDAY_NODE_OK=0"
where node >nul 2>nul && node "%CD%\scripts\check-engines.cjs" >nul 2>nul && set "FRIDAY_NODE_OK=1"
if "%FRIDAY_NODE_OK%"=="0" (
  echo [FRIDAY] Node.js 22.19.0+ was not found - preparing the Windows toolchain first ^(scripts\setup-windows.ps1^)
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup-windows.ps1"
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul || (echo [FRIDAY] Node.js 22.19.0+ is still missing - install it from https://nodejs.org and run this again & popd & exit /b 1)
)
node "%CD%\scripts\build-pipeline.cjs" --channel production --caller cmd %*
set "FRIDAY_BUILD_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %FRIDAY_BUILD_CODE%
