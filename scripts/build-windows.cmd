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
where node >nul 2>nul || (echo [FRIDAY] Node.js 22.19.0+ is required - https://nodejs.org & popd & exit /b 1)
node "%CD%\scripts\build-pipeline.cjs" --channel production --caller cmd %*
set "FRIDAY_BUILD_CODE=%ERRORLEVEL%"
popd
endlocal & exit /b %FRIDAY_BUILD_CODE%
