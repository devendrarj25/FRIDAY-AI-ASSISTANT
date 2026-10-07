@echo off
setlocal enableextensions
title FRIDAY - Windows build

REM FRIDAY - Personal AI Assistant
REM Publisher: Devendra Singh Meena (devendrarj25)
REM
REM One command builds everything into the FRIDAY project folder:
REM   dist-desktop\   renderer bundle
REM   release\        FRIDAY-Setup-<public-version>.exe, FRIDAY-Portable-<public-version>.exe, win-unpacked\
REM
REM Usage (from the extracted FRIDAY project root, wherever it lives):
REM   scripts\build-windows.cmd            installer + portable
REM   scripts\build-windows.cmd nsis       installer only
REM   scripts\build-windows.cmd dir        unpacked folder only (fast, for debugging)

pushd "%~dp0.." || (echo [FRIDAY] project folder could not be opened & exit /b 1)
set "FRIDAY_ROOT=%CD%"
echo [FRIDAY] project root: %FRIDAY_ROOT%

REM Everything electron-builder caches stays inside the FRIDAY folder so a
REM broken global cache in %LOCALAPPDATA% can never poison the build again.
set "ELECTRON_BUILDER_CACHE=%FRIDAY_ROOT%\.cache\electron-builder"
set "ELECTRON_CACHE=%FRIDAY_ROOT%\.cache\electron"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
if not exist "%ELECTRON_BUILDER_CACHE%" mkdir "%ELECTRON_BUILDER_CACHE%"
if not exist "%ELECTRON_CACHE%" mkdir "%ELECTRON_CACHE%"

REM The winCodeSign package that caused
REM   "Cannot create symbolic link : A required privilege is not held by the client"
REM is never downloaded now (resource editing uses the local rcedit package),
REM but a half-extracted copy from an earlier failed run must be removed.
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
  echo [FRIDAY] removing broken winCodeSign cache from earlier failed build...
  rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul
)
if exist "%ELECTRON_BUILDER_CACHE%\winCodeSign" (
  echo [FRIDAY] removing project winCodeSign cache from earlier failed build...
  rmdir /s /q "%ELECTRON_BUILDER_CACHE%\winCodeSign" 2>nul
)

where node >nul 2>nul || (echo [FRIDAY] Node.js 22.19.0+ is required - https://nodejs.org & exit /b 1)

REM The local build must satisfy exactly the same package.json engines as
REM GitHub CI, checked BEFORE npm ci so a wrong toolchain fails early.
call node "%FRIDAY_ROOT%\scripts\check-engines.cjs" || exit /b 1

echo [FRIDAY] synchronizing npm dependencies from package-lock.json...
if not exist "package-lock.json" (
  echo [FRIDAY] package-lock.json is required for a reproducible build.
  exit /b 1
)
call npm ci --no-audit --no-fund
if errorlevel 1 (
  echo [FRIDAY] npm ci failed - verifying cache and retrying against registry.npmjs.org...
  call npm cache verify
  call npm ci --no-audit --no-fund --registry https://registry.npmjs.org/ || exit /b 1
)


REM Packaging must never continue without the resolved Electron runtime.
call node "%FRIDAY_ROOT%\scripts\ensure-electron.cjs" --quiet || exit /b 1

REM Create/reuse the live venv (selected FRIDAY folder runtime\.venv when a
REM folder is selected, otherwise the project .venv), initialize runtime
REM storage including the bundled wake model, then require a genuine
REM readiness PASS. No global Python package set is ever used.
echo [FRIDAY] preparing the isolated Python runtime...
call node "%FRIDAY_ROOT%\scripts\setup-python.cjs" || exit /b 1
call node "%FRIDAY_ROOT%\scripts\init-runtime.cjs" || exit /b 1
echo [FRIDAY] checking the build environment...
call node "%FRIDAY_ROOT%\scripts\check-environment.cjs" --fix || exit /b 1


echo [FRIDAY] recording the dependency/environment registry (repairing anything missing)...
call node "%FRIDAY_ROOT%\scripts\env-registry.cjs" repair || exit /b 1

echo [FRIDAY] self-healing version/documentation drift (canonical friday-version.json is the single truth)...
REM One idempotent repair: package-lock, renderer fallback, LICENSE year, every
REM governed document, CHANGELOG (one heading per version), releases/notes,
REM README "What is new" and the docs index. A tree that is already in sync is
REM not touched. Anything repaired is listed above so it can simply be committed;
REM only drift the engine cannot repair stops the build, with the exact reason.
call node "%FRIDAY_ROOT%\scripts\release-engine.cjs" heal || exit /b 1
call node "%FRIDAY_ROOT%\scripts\release-engine.cjs" verify || exit /b 1

echo [FRIDAY] checking main-process dependencies...
call node "%FRIDAY_ROOT%\scripts\verify-deps.cjs" || exit /b 1

echo [FRIDAY] cleaning previous output...
REM Do not write if exist "folder\" - the backslash escapes the quote in cmd.exe
REM and can stop the pack after this line. The owner-verified pack used:
if exist "release" rmdir /s /q "release" 2>nul
if exist "dist-desktop" rmdir /s /q "dist-desktop" 2>nul

echo [FRIDAY] building renderer bundle -> dist-desktop\
call npm run build:desktop || exit /b 1
if not exist "dist-desktop\index.html" (
  echo [FRIDAY] renderer bundle missing - build failed.
  exit /b 1
)

if /i "%~1"=="dir" goto package_dir
if /i "%~1"=="nsis" goto package_nsis
if /i "%~1"=="portable" goto package_portable

echo [FRIDAY] packaging Windows app (installer + portable) -^> release\
call node "%FRIDAY_ROOT%\scripts\electron-pack.cjs" --win nsis portable || goto build_failed
goto packaged

:package_dir
echo [FRIDAY] packaging Windows app (unpacked debug build) -^> release\
call node "%FRIDAY_ROOT%\scripts\electron-pack.cjs" --win --dir || goto build_failed
goto packaged

:package_nsis
echo [FRIDAY] packaging Windows app (installer) -^> release\
call node "%FRIDAY_ROOT%\scripts\electron-pack.cjs" --win nsis || goto build_failed
goto packaged

:package_portable
echo [FRIDAY] packaging Windows app (portable) -^> release\
call node "%FRIDAY_ROOT%\scripts\electron-pack.cjs" --win portable || goto build_failed

:packaged

echo.
echo [FRIDAY] build finished. Artifacts in %FRIDAY_ROOT%\release
dir /b "release\*.exe" 2>nul
echo.
if defined CSC_LINK (
  echo [FRIDAY] Authenticode-signing release executables...
  if not exist "%CSC_LINK%" (
    echo [FRIDAY] CSC_LINK is set but the PFX file is missing: %CSC_LINK%
    goto verify_failed
  )
  powershell -NoProfile -ExecutionPolicy Bypass -File "%FRIDAY_ROOT%\scripts\sign-windows.ps1" -PfxPath "%CSC_LINK%" -PfxPassword "%CSC_KEY_PASSWORD%" -TargetDir "%FRIDAY_ROOT%\release"
  if errorlevel 1 goto verify_failed
) else (
  echo [FRIDAY] unsigned build. Set CSC_LINK and CSC_KEY_PASSWORD to a CA-issued PFX to Authenticode-sign.
  echo          Signing a new publisher does not by itself remove SmartScreen warnings.
)
echo.
echo [FRIDAY] verifying artifacts and branding...
call node "%FRIDAY_ROOT%\scripts\verify-build.cjs" %~1 || goto verify_failed
echo.
echo [FRIDAY] verifying that FRIDAY boots in EXE and browser mode...
call node "%FRIDAY_ROOT%\scripts\verify-boot.cjs" || goto verify_failed
echo.
echo [FRIDAY] running the post-build readiness test (kernel, database, chat, voice, model, task)...
call node "%FRIDAY_ROOT%\scripts\readiness-test.cjs" --pack || goto verify_failed
echo.
echo [FRIDAY] build complete.
popd
endlocal
exit /b 0

:build_failed
echo.
echo [FRIDAY] Windows packaging failed. Review the error above.
popd
endlocal
exit /b 1

:verify_failed
echo.
echo [FRIDAY] artifacts were produced but verification failed - see the report above.
popd
endlocal
exit /b 1
