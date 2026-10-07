@echo off
setlocal enableextensions
title FRIDAY - Isolated Python runtime setup

REM Compatibility entry point. The canonical setup implementation is the Node
REM script below; keeping one implementation prevents global/project Python
REM behavior from drifting apart.
pushd "%~dp0.." || (echo [FRIDAY] project folder could not be opened & exit /b 1)
where node >nul 2>nul || (
  echo [FRIDAY] A supported Node.js version is required. Run scripts\setup-windows.ps1.
  popd & exit /b 1
)
call node "%CD%\scripts\setup-python.cjs"
set "RESULT=%ERRORLEVEL%"
popd
endlocal & exit /b %RESULT%
