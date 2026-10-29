@echo off
setlocal EnableExtensions
title FRIDAY - Windows build

REM FRIDAY - Personal AI Assistant
REM Publisher: Devendra Singh Meena (devendrarj25)
REM
REM Thin wrapper. The phase list lives in scripts\build-pipeline.cjs so the
REM CMD pack, FRIDAY Release, and FRIDAY Test Build cannot drift apart.
REM
REM The whole flow, in order, with nothing optional:
REM   npm run setup    installs the toolchain and every dependency (latest stable
REM                    release when missing or below the floor, reused otherwise)
REM   npm run doctor   checks everything and repairs what it can (the backup when
REM                    setup stopped halfway)
REM   npm run build:win (this file) checks the PC, installs what is still missing,
REM                    builds, verifies, runs the requirement tests and prints
REM                    FRIDAY BUILD READY with the files to use
REM
REM Usage (from the FRIDAY project root, wherever it lives):
REM   scripts\build-windows.cmd            installer + portable
REM   scripts\build-windows.cmd nsis       installer only
REM   scripts\build-windows.cmd portable   portable only
REM   scripts\build-windows.cmd dir        unpacked folder only

pushd "%~dp0.." || (echo [FRIDAY] project folder could not be opened & exit /b 1)

echo [FRIDAY] Step 1 of 2 - the PC: Node.js, npm, Python, Git, PowerShell, FFmpeg, Tesseract, Visual C++
REM A fresh PC has no Node.js. Prepare the Windows toolchain first (Node.js, Python,
REM Git, PowerShell, FFmpeg, Tesseract, Visual C++ through winget or the official
REM downloads), then carry on. A PC whose Node.js already meets the floor (22.19.0+)
REM is not touched here; the build checks and installs the rest as its first phase.
set "FRIDAY_NODE_OK=0"
where node >nul 2>nul && node "%CD%\scripts\check-engines.cjs" >nul 2>nul && set "FRIDAY_NODE_OK=1"
if "%FRIDAY_NODE_OK%"=="0" (
  echo [FRIDAY] Node.js 22.19.0+ was not found - preparing the Windows toolchain first ^(scripts\setup-windows.ps1 -ToolchainOnly^)
  powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\setup-windows.ps1" -ToolchainOnly
  if errorlevel 1 (echo [FRIDAY] The Windows toolchain could not be prepared - see the reason above. Fix it, then run npm run doctor ^(or this file again^) & popd & exit /b 1)
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
  where node >nul 2>nul || (echo [FRIDAY] Node.js 22.19.0+ is still missing - close this window, open a new CMD and run this again & popd & exit /b 1)
)

echo [FRIDAY] Step 2 of 2 - check, install what is missing, build, verify and run the requirement tests
node "%CD%\scripts\build-pipeline.cjs" --channel production --caller cmd %*
set "FRIDAY_BUILD_CODE=%ERRORLEVEL%"
if not "%FRIDAY_BUILD_CODE%"=="0" echo [FRIDAY] The build stopped with exit code %FRIDAY_BUILD_CODE%. Read the first error above, then run npm run doctor and this file again.
popd
endlocal & exit /b %FRIDAY_BUILD_CODE%
