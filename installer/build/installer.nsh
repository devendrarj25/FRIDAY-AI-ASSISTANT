; FRIDAY — NSIS installer customisation
;
; ONE ROOT. Setup asks a single question - "Where should FRIDAY live?" - and
; everything follows from that one folder:
;   <root>\App\        the program files ($INSTDIR)
;   <root>\database\, memory\, models\, ...  the data, as siblings
;
; Three guarantees are encoded here:
;   1. Setup asks for ONE folder, reuses an existing FRIDAY root and never
;      nests FRIDAY inside FRIDAY (or App inside App).
;   2. A normal uninstall removes only <root>\App plus registry values, and
;      keeps every data folder in <root> exactly as it is.
;   3. Uninstall offers one explicit, unticked "Delete all FRIDAY data too"
;      choice, which - and only which - removes the whole <root>.

; Custom include files are parsed before electron-builder's standard headers in
; builder 25. Include the guarded NSIS headers used below so all macros exist at
; parse time; their include guards prevent duplicate definitions later.
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "friday-version.nsh"

; electron-builder's stock check shows a modal "FRIDAY is running" prompt and
; only targets the parent image. FRIDAY owns a kernel and Chromium child tree,
; so Setup/Uninstall closes that exact installed tree and waits for its files
; to become exclusively openable before replacing or removing them.
!macro customCheckAppRunning
  DetailPrint "Closing FRIDAY and waiting for its files to be released..."
  IfFileExists "$INSTDIR\resources\installer\build\close-friday.ps1" 0 friday_inline_close
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\build\close-friday.ps1" -InstallDir "$INSTDIR"'
    Pop $0
    Goto friday_close_done
  friday_inline_close:
    ; Upgrading an older build may predate the packaged lifecycle helper. Match
    ; the executable by its full path and let taskkill close only that PID tree.
    IfFileExists "$INSTDIR\FRIDAY.exe" 0 friday_nothing_running
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p=Get-CimInstance Win32_Process|?{$$_.ExecutablePath -and ($$_.ExecutablePath -ieq $\'$INSTDIR\FRIDAY.exe$\' -or $$_.ExecutablePath.StartsWith($\'$INSTDIR\$\',[StringComparison]::OrdinalIgnoreCase))};foreach($$x in $$p){& $$env:SystemRoot\System32\taskkill.exe /PID $$x.ProcessId /T /F|Out-Null};for($$i=0;$$i -lt 80;$$i++){if(-not(Get-CimInstance Win32_Process|?{$$_.ExecutablePath -and ($$_.ExecutablePath -ieq $\'$INSTDIR\FRIDAY.exe$\' -or $$_.ExecutablePath.StartsWith($\'$INSTDIR\$\',[StringComparison]::OrdinalIgnoreCase))})){exit 0};Start-Sleep -Milliseconds 250};exit 1"'
    Pop $0
    Goto friday_close_done
  friday_nothing_running:
    StrCpy $0 0
  friday_close_done:
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "FRIDAY could not be closed completely. Close FRIDAY, then run Setup again."
    Quit
  ${EndIf}
!macroend

; The first pass builds the uninstaller. Do not declare installer-only page
; functions in that pass or NSIS warning 6010 is treated as a fatal error.
!ifndef BUILD_UNINSTALLER

Var FridayRoot
Var FridayRootText
Var FridayDetected
Var FridayDetectedText

; ONE ROOT MODEL
; --------------
; The user picks a single folder, e.g. D:\FRIDAY. Inside it:
;   <root>\App\      the installed program files ($INSTDIR)
;   <root>\database\, memory\, models\, agents\, skills\, plugins\, ... the
;                    data folders defined by electron/friday-contract.cjs
; HKCU\Software\FRIDAY\WorkspacePath keeps pointing at <root> — the same
; pointer friday-paths.cjs / rootFromEnv() already read. There is no second
; root-tracking mechanism.
;
; Silent installs and in-place upgrades do not visit the custom folder page,
; so the same values are established here.
; An explicit "/D=<root>" on the command line (silent installs, CI lifecycle
; tests, scripted deployments) is the owner's choice and must win over both the
; registry pointer and the default. NSIS strips /D from ${GetParameters} but
; keeps it in $CMDLINE, so it is detected there.
Var FridayCmdRoot
Function FridayDetectCmdRoot
  StrCpy $FridayCmdRoot "0"
  StrCpy $R0 0
  friday_cmd_loop:
    StrCpy $R1 "$CMDLINE" 3 $R0
    StrCmp $R1 "" friday_cmd_done
    StrCmp $R1 "/D=" friday_cmd_found
    StrCmp $R1 "/d=" friday_cmd_found
    IntOp $R0 $R0 + 1
    Goto friday_cmd_loop
  friday_cmd_found:
    StrCpy $FridayCmdRoot "1"
  friday_cmd_done:
FunctionEnd

!macro customInit
  Call FridayDetectCmdRoot
  ; NSIS does not always keep "/D=" in $CMDLINE, so a second, independent proof
  ; of an explicit folder is used: NSIS assigns /D straight to $INSTDIR before
  ; init runs, so an $INSTDIR that is neither empty nor the packaged default
  ; can only have come from the command line.
  ${If} $FridayCmdRoot != "1"
  ${AndIf} $INSTDIR != ""
  ${AndIf} $INSTDIR != "$LOCALAPPDATA\Programs\${APP_FILENAME}"
  ${AndIf} $INSTDIR != "$PROGRAMFILES64\${APP_FILENAME}"
  ${AndIf} $INSTDIR != "$PROGRAMFILES\${APP_FILENAME}"
    StrCpy $FridayCmdRoot "1"
  ${EndIf}
  ${If} $FridayCmdRoot == "1"
    ; $INSTDIR already holds the folder passed with /D. Treat it as the ONE
    ; root (tolerating a root that already ends in \App) and install into
    ; <root>\App exactly like the wizard does.
    StrCpy $0 "$INSTDIR" "" -4
    ${If} $0 == "\App"
      StrCpy $FridayRoot "$INSTDIR" -4
    ${Else}
      StrCpy $FridayRoot "$INSTDIR"
    ${EndIf}
  ${Else}
    ReadRegStr $FridayRoot HKCU "Software\FRIDAY" "WorkspacePath"
    ${If} $FridayRoot == ""
      StrCpy $FridayRoot "$PROFILE\FRIDAY"
    ${EndIf}
  ${EndIf}
  StrCpy $INSTDIR "$FridayRoot\App"
!macroend


!macro customPageAfterChangeDir
  Page custom FridayRootPageCreate FridayRootPageLeave
!macroend

Function FridayRootPageCreate
  ; Reuse a previously chosen root when FRIDAY is already installed.
  ReadRegStr $FridayRoot HKCU "Software\FRIDAY" "WorkspacePath"
  ${If} $FridayRoot == ""
    StrCpy $FridayRoot "$PROFILE\FRIDAY"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Where should FRIDAY live?" \
    "One folder holds all of FRIDAY: the program and your data, side by side."

  ${NSD_CreateLabel} 0 0 100% 32u \
    "FRIDAY installs into <folder>\App and keeps your database, memory, models, \
agents, skills, plugins and workflows in sibling folders under the same root. \
An existing FRIDAY folder is detected and reused - nothing inside it is deleted \
or overwritten, and it survives a normal uninstall."
  Pop $0

  ${NSD_CreateDirRequest} 0 38u 80% 12u "$FridayRoot"
  Pop $FridayRootText

  ${NSD_CreateBrowseButton} 82% 38u 18% 12u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 FridayRootBrowse

  ${NSD_CreateLabel} 0 56u 100% 24u ""
  Pop $FridayDetectedText

  Call FridayRootDetect
  nsDialogs::Show
FunctionEnd

Function FridayRootBrowse
  ${NSD_GetText} $FridayRootText $0
  nsDialogs::SelectFolderDialog "Select the FRIDAY folder" "$0"
  Pop $1
  ${If} $1 != error
    ${NSD_SetText} $FridayRootText "$1"
    Call FridayRootDetect
  ${EndIf}
FunctionEnd

; Reports what already exists so the user knows the folder is reused, not reset.
Function FridayRootDetect
  ${NSD_GetText} $FridayRootText $FridayRoot
  StrCpy $FridayDetected ""

  ${If} ${FileExists} "$FridayRoot\database\friday.sqlite3"
  ${OrIf} ${FileExists} "$FridayRoot\database\friday.db"
    StrCpy $FridayDetected "$FridayDetected database, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\config\*.*"
    StrCpy $FridayDetected "$FridayDetected config, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\memory\*.*"
    StrCpy $FridayDetected "$FridayDetected memory, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\models\*.*"
    StrCpy $FridayDetected "$FridayDetected models, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\agents\*.*"
    StrCpy $FridayDetected "$FridayDetected agents, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\skills\*.*"
    StrCpy $FridayDetected "$FridayDetected skills, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\plugins\*.*"
    StrCpy $FridayDetected "$FridayDetected plugins, "
  ${EndIf}
  ${If} ${FileExists} "$FridayRoot\workflows\*.*"
    StrCpy $FridayDetected "$FridayDetected workflows, "
  ${EndIf}

  ${If} $FridayDetected == ""
    ${NSD_SetText} $FridayDetectedText "New FRIDAY folder - the program goes to $FridayRoot\App and the full data structure is created beside it."
  ${Else}
    ${NSD_SetText} $FridayDetectedText "Existing FRIDAY folder detected ($FridayDetected) - it will be validated and reused, never overwritten. Only $FridayRoot\App is replaced."
  ${EndIf}
FunctionEnd

; Rejects roots that would need UAC for ordinary file writes. FRIDAY's own
; self-repair and self-development rewrite files under the root while running
; asInvoker, so the whole root must be writable without an elevation prompt.
!macro FridayRejectProtected Protected Label
  StrLen $1 "${Protected}"
  StrCpy $2 "$FridayRoot" $1
  ${If} $2 == "${Protected}"
    MessageBox MB_ICONSTOP "FRIDAY cannot live inside ${Label}.$\r$\nThat location needs administrator rights for every write, which blocks FRIDAY's self-repair.$\r$\nChoose a normal folder, for example $PROFILE\FRIDAY or D:\FRIDAY."
    Abort
  ${EndIf}
!macroend

Function FridayRootPageLeave
  ${NSD_GetText} $FridayRootText $FridayRoot
  ${If} $FridayRoot == ""
    MessageBox MB_ICONSTOP "Please choose a folder for FRIDAY."
    Abort
  ${EndIf}

  !insertmacro FridayRejectProtected "$PROGRAMFILES" "Program Files"
  !insertmacro FridayRejectProtected "$PROGRAMFILES64" "Program Files"
  !insertmacro FridayRejectProtected "$WINDIR" "the Windows folder"

  ; Picking the program folder of an existing installation means the root is
  ; its parent — never install FRIDAY into <root>\App\App. Plain string work
  ; only, so this behaves identically in the installer and uninstaller passes.
  StrCpy $0 "$FridayRoot" "" -4
  ${If} $0 == "\App"
  ${AndIf} ${FileExists} "$FridayRoot\FRIDAY.exe"
    StrCpy $FridayRoot "$FridayRoot" -4
  ${EndIf}


  ; Never create FRIDAY\FRIDAY: if the chosen folder already contains a FRIDAY
  ; root, use that one instead of appending another FRIDAY segment.
  ${GetFileName} "$FridayRoot" $0
  ${If} $0 != "FRIDAY"
  ${AndIf} ${FileExists} "$FridayRoot\FRIDAY\*.*"
    StrCpy $FridayRoot "$FridayRoot\FRIDAY"
  ${EndIf}

  ; The one decision of this page: root chosen, program folder derived from it.
  CreateDirectory "$FridayRoot"
  StrCpy $INSTDIR "$FridayRoot\App"
  WriteRegStr HKCU "Software\FRIDAY" "WorkspacePath" "$FridayRoot"
FunctionEnd



; Python discovery and provisioning live in installer/build/install-python.ps1,
; driven by installer/build/repair-runtime.ps1 below. It is the single canonical
; implementation: it reuses any installed CPython that meets the 3.12.10 floor
; (3.13 / 3.14 / newer pass) and only then downloads an official installer.
; No duplicate discovery is kept here: unreferenced NSIS functions raise
; warning 6010, which the uninstaller pass treats as a fatal build error.





!macro customInstall
  ; The app reads this at first run to locate the ONE root. $INSTDIR is always
  ; "<root>\App", so the program folder is a sibling of the data folders.
  ${If} $FridayRoot == ""
    StrCpy $0 "$INSTDIR" "" -4
    ${If} $0 == "\App"
      StrCpy $FridayRoot "$INSTDIR" -4
    ${Else}
      StrCpy $FridayRoot "$INSTDIR"
    ${EndIf}
  ${EndIf}

  WriteRegStr HKCU "Software\FRIDAY" "WorkspacePath" "$FridayRoot"
  ${If} "${PRODUCT_NAME}" == "FRIDAY Test"
    WriteRegStr HKCU "Software\FRIDAY Test" "InstallPath" "$INSTDIR"
  ${Else}
    WriteRegStr HKCU "Software\FRIDAY" "InstallPath" "$INSTDIR"
  ${EndIf}


  ; The installed EXE prefers its own isolated Python environment, created by
  ; the repair helper at "$INSTDIR\runtime\.venv" and removed on uninstall.

  ;
  ; Version policy: the project minimum is a FLOOR. Any already installed stable
  ; Python that satisfies it (3.12.10, 3.13.x, 3.14.x, newer) is detected and
  ; reused as-is. Nothing is downloaded or installed in that case.
  ;
  ; IMPORTANT: nothing in this block may abort Setup. A missing or partial
  ; Python runtime is repaired by FRIDAY itself on first run (Setup & Doctor),
  ; so the application, its shortcuts and its uninstaller are ALWAYS registered.
  ; Aborting here used to leave a half-installed FRIDAY that could not be
  ; uninstalled from Apps & Features.
  ; Re-running Setup is Repair mode. The helper verifies every runtime layer
  ; (interpreter, venv, pip, requirements, imports and SQLite), reuses healthy
  ; components and rebuilds only the damaged isolated environment. PowerShell's
  ; argument binding avoids the nested cmd.exe quoting that broke paths with
  ; spaces in previous installers.
  DetailPrint "Verifying and repairing FRIDAY's installed runtime..."
  Delete "$TEMP\friday-runtime-status.txt"
  IfFileExists "$INSTDIR\resources\installer\build\repair-runtime.ps1" 0 runtime_helper_missing
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\build\repair-runtime.ps1" -InstallDir "$INSTDIR" -StatusFile "$TEMP\friday-runtime-status.txt"'
  Pop $0
  ${If} $0 == 0
    ${If} "${PRODUCT_NAME}" == "FRIDAY Test"
      DeleteRegValue HKCU "Software\FRIDAY Test" "PythonSetupPending"
      WriteRegStr HKCU "Software\FRIDAY Test" "LastInstallMode" "installed-or-repaired"
    ${Else}
      DeleteRegValue HKCU "Software\FRIDAY" "PythonSetupPending"
      WriteRegStr HKCU "Software\FRIDAY" "LastInstallMode" "installed-or-repaired"
    ${EndIf}
    Goto runtime_done
  ${EndIf}
  StrCpy $R5 "runtime-repair-$0"
  Goto runtime_pending

  runtime_helper_missing:
  StrCpy $R5 "runtime-helper-missing"

  runtime_pending:
  ${If} $R5 != ""
    ; Recorded for Setup & Doctor, which repairs the runtime inside the app.
    ${If} "${PRODUCT_NAME}" == "FRIDAY Test"
      WriteRegStr HKCU "Software\FRIDAY Test" "PythonSetupPending" "$R5"
    ${Else}
      WriteRegStr HKCU "Software\FRIDAY" "PythonSetupPending" "$R5"
    ${EndIf}
    DetailPrint "Runtime repair is pending ($R5). FRIDAY installation will still complete."
  ${EndIf}
  runtime_done:
  !ifdef UNINSTALL_REGISTRY_KEY
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${FRIDAY_DISPLAY_VERSION}"
  !endif
!macroend

!endif

; Uninstall data contract — the ONLY two outcomes:
;
;   keep   (default, checkbox unticked): the application, its caches and its
;          registry values are removed. The FRIDAY data folder and the
;          WorkspacePath pointer survive completely untouched.
;
;   delete (checkbox ticked + a second YES/NO warning): everything "keep"
;          removes PLUS the whole FRIDAY data folder and every other trace
;          FRIDAY left on this PC, so a later Setup starts perfectly fresh.
;
; The decision and the data root live in dedicated variables. They used to live
; in the $R6/$R7 scratch registers, which electron-builder's own uninstaller
; code reuses between the welcome page and customUnInstall — that is how a
; "keep" uninstall could still end up deleting data, and how a "delete"
; uninstall could end up finding an empty root and leaving everything behind.
; Declared ONLY in the uninstaller pass. electron-builder compiles this script
; twice and inserts the un. macros below in the uninstaller pass only, so in the
; installer pass these variables would be declared and never referenced — NSIS
; warning 6001 ("Variable ... not referenced or never set, wasting memory"),
; which electron-builder treats as a fatal error and which stopped the NSIS
; installer from being produced at all.
!ifdef BUILD_UNINSTALLER
Var FridayUnMode
Var FridayUnRoot
!endif

!macro customUnInit
  ; Default for every path, including a silent uninstall and the uninstaller
  ; that a reinstall/upgrade runs first: KEEP the data.
  StrCpy $FridayUnMode "keep"
  ReadRegStr $FridayUnRoot HKCU "Software\FRIDAY" "WorkspacePath"
  ${If} ${Silent}
    DetailPrint "Silent uninstall - keeping the FRIDAY data folder: $FridayUnRoot"
  ${EndIf}
!macroend

!macro customUnInstall
  ; Re-read the pointer: a custom page may not have run (silent/upgrade path).
  ${If} $FridayUnRoot == ""
    ReadRegStr $FridayUnRoot HKCU "Software\FRIDAY" "WorkspacePath"
  ${EndIf}
  ; ONE ROOT MODEL: the program folder is "<root>\App". When the pointer is
  ; missing (registry wiped by hand) the root is still recoverable from the
  ; folder the uninstaller is running from — never guessed anywhere else.
  ${If} $FridayUnRoot == ""
    StrCpy $0 "$INSTDIR" "" -4
    ${If} $0 == "\App"
      StrCpy $FridayUnRoot "$INSTDIR" -4
    ${EndIf}
  ${EndIf}

  ${If} $FridayUnMode != "delete"
    StrCpy $FridayUnMode "keep"
  ${EndIf}

  ; KEEP MODE CONTRACT: the ONLY folder a keep-uninstall may remove is
  ; $INSTDIR (= <root>\App). Every sibling under <root> — database, memory,
  ; models, agents, skills, plugins, workflows, config, credentials — is left
  ; byte-for-byte untouched, exactly as in the previous two-folder design.


  ; LAST-LINE DATA GUARD (keep mode only).
  ; electron-builder's uninstall section always ends with an unconditional
  ; `RMDir /r $INSTDIR`. Setup normally refuses a data folder inside the program
  ; folder, but that check only runs on the interactive folder page — an upgrade,
  ; a silent install or a pointer written by an older build can still leave the
  ; FRIDAY root inside $INSTDIR. In that state a "keep" uninstall used to erase
  ; every model, memory and credential together with the program. Move the data
  ; out of harm's way first and re-point WorkspacePath at its new home, so
  ; "keep" really keeps and a later Setup reuses exactly the same data.
  ${If} $FridayUnMode == "keep"
  ${AndIf} $FridayUnRoot != ""
    StrLen $2 "$INSTDIR"
    StrCpy $3 "$FridayUnRoot" $2
    ${If} $3 == "$INSTDIR"
      StrCpy $4 "$PROFILE\FRIDAY"
      ${If} ${FileExists} "$4\*.*"
        StrCpy $4 "$PROFILE\FRIDAY-preserved"
      ${EndIf}
      DetailPrint "Moving the FRIDAY data folder out of the program folder to keep it: $4"
      ClearErrors
      Rename "$FridayUnRoot" "$4"
      ${If} ${Errors}
        ; Different volume or a locked handle — copy it out instead.
        nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Move-Item -LiteralPath $\'$FridayUnRoot$\' -Destination $\'$4$\' -Force -ErrorAction SilentlyContinue"'
        Pop $0
      ${EndIf}
      ${If} ${FileExists} "$4\*.*"
        StrCpy $FridayUnRoot "$4"
        WriteRegStr HKCU "Software\FRIDAY" "WorkspacePath" "$4"
        DetailPrint "FRIDAY data preserved at $4 - a new installation will reuse it."
      ${EndIf}
    ${EndIf}
  ${EndIf}



  ; TEST is a separate installed product but deliberately shares the root's
  ; immutable resources. Removing TEST must never offer to erase production.
  ${If} "${PRODUCT_NAME}" == "FRIDAY Test"
    DetailPrint "Keeping the shared FRIDAY data folder while removing FRIDAY Test: $FridayUnRoot"
    ${If} $FridayUnRoot != ""
      RMDir /r "$FridayUnRoot\profiles\test"
    ${EndIf}
    DeleteRegKey HKCU "Software\FRIDAY Test"
  ${Else}
    ${If} $FridayUnMode == "delete"
      ${If} $FridayUnRoot != ""
        DetailPrint "Deleting all FRIDAY data in $FridayUnRoot (explicitly requested)..."
        RMDir /r "$FridayUnRoot"
      ${EndIf}
      ; Every other trace FRIDAY can leave behind, so the next installation is
      ; a genuinely fresh install with no leftovers anywhere on the PC.
      RMDir /r "$APPDATA\FRIDAY"
      RMDir /r "$LOCALAPPDATA\FRIDAY"
      RMDir /r "$LOCALAPPDATA\Programs\FRIDAY"
      RMDir /r "$LOCALAPPDATA\friday-cache"
      RMDir /r "$LOCALAPPDATA\friday-updater"
      RMDir /r "$APPDATA\FRIDAY Test"
      RMDir /r "$LOCALAPPDATA\FRIDAY Test"
      Delete "$TEMP\friday-runtime-status.txt"
      RMDir /r "$TEMP\friday-bootstrap"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FRIDAY"
      DeleteRegKey HKCU "Software\FRIDAY"
      DeleteRegKey HKCU "Software\FRIDAY Test"
      DetailPrint "FRIDAY was removed completely. Nothing of FRIDAY is left on this PC."
    ${Else}
      DetailPrint "Keeping the FRIDAY data folder and its pointer: $FridayUnRoot"
      ; Explicitly preserved in this mode: $FridayUnRoot and
      ; HKCU\Software\FRIDAY\WorkspacePath, so a later install reuses it.
      DeleteRegValue HKCU "Software\FRIDAY" "InstallPath"
      DeleteRegValue HKCU "Software\FRIDAY" "PythonSetupPending"
      DeleteRegValue HKCU "Software\FRIDAY" "LastInstallMode"
      DeleteRegKey /ifempty HKCU "Software\FRIDAY"
    ${EndIf}
  ${EndIf}

  ; Application-only leftovers: removed by BOTH modes, never user content.
  RMDir /r "$LOCALAPPDATA\friday-cache"
  RMDir /r "$LOCALAPPDATA\friday-updater"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  ; The isolated Python runtime is created by Setup inside the program folder,
  ; so it is removed with the program. User data lives in the FRIDAY folder.
  RMDir /r "$INSTDIR\runtime"
  ${If} $FridayUnMode == "delete"
    ; The uninstaller is still running from "<root>\App", so the very last
    ; leftovers — the program folder AND the root that now contains only it —
    ; are swept by a detached helper that waits for this process to exit.
    ; Nothing of FRIDAY survives a "delete" uninstall.
    nsExec::Exec 'cmd.exe /c start "" /min "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 6; Remove-Item -LiteralPath $\'$INSTDIR$\' -Recurse -Force -ErrorAction SilentlyContinue; if ($\'$FridayUnRoot$\' -ne $\'$\') { Remove-Item -LiteralPath $\'$FridayUnRoot$\' -Recurse -Force -ErrorAction SilentlyContinue }"'
    Pop $0
  ${EndIf}

!macroend

; The uninstall welcome page carries the one and only data decision:
;   [ ] Delete all FRIDAY data and resources
; It is unchecked by default, so a normal uninstall removes the application and
; leaves every chat, memory, setting, credential, model, runtime, voice and tool
; exactly where it is. Ticking it asks for one final confirmation.
;
; electron-builder compiles this script twice. The FIRST pass (BUILD_UNINSTALLER
; defined) is the only one that calls WriteUninstaller; the SECOND pass packs the
; already-built uninstaller with File. Any "un." function left visible in that
; second pass is uninstaller code in a script that never calls WriteUninstaller,
; which is NSIS warning 6020 — and electron-builder treats warnings as errors,
; so no uninstaller was produced at all. Keep every "un." symbol inside the
; uninstaller pass; the macros above stay defined for both passes because
; electron-builder only inserts them where they belong.
!ifdef BUILD_UNINSTALLER

Var FridayUnDeleteData

!macro customUnWelcomePage
  UninstPage custom un.FridayDataPagePre un.FridayDataPageLeave
!macroend

Function un.FridayDataPagePre
  ; Authoritative read of the data root for the whole uninstall.
  ReadRegStr $FridayUnRoot HKCU "Software\FRIDAY" "WorkspacePath"
  StrCpy $FridayUnMode "keep"
  ${If} "${PRODUCT_NAME}" == "FRIDAY Test"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Uninstall FRIDAY" "Choose what happens to your FRIDAY data."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Uninstall FRIDAY removes only the program folder ($INSTDIR).$\r$\nEverything else in your FRIDAY folder is kept unless you tick the box below."
  Pop $1

  ${If} $FridayUnRoot != ""
    ${NSD_CreateLabel} 0 28u 100% 24u "FRIDAY folder: $FridayUnRoot$\r$\nIts sibling folders hold your database, memory, conversations, settings, credentials, models, runtimes, voices and tools - all kept by a normal uninstall."
    Pop $1
    ${NSD_CreateCheckbox} 0 56u 100% 12u "Delete all FRIDAY data too - complete removal of $FridayUnRoot (cannot be undone)"
    Pop $FridayUnDeleteData
    ${NSD_SetState} $FridayUnDeleteData ${BST_UNCHECKED}

  ${Else}
    StrCpy $FridayUnDeleteData ""
    ${NSD_CreateLabel} 0 28u 100% 20u "No FRIDAY data folder is registered on this PC - only the application will be removed."
    Pop $1
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.FridayDataPageLeave
  StrCpy $FridayUnMode "keep"
  ${If} $FridayUnDeleteData != ""
    ${NSD_GetState} $FridayUnDeleteData $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONSTOP|MB_DEFBUTTON2 \
        "This permanently deletes EVERYTHING in:$\r$\n$FridayUnRoot$\r$\n$\r$\nChats, memory, settings, credentials, models, runtimes and voices.$\r$\nThis cannot be undone. Delete all FRIDAY data?" \
        /SD IDNO IDYES friday_confirm_delete
      Abort
      friday_confirm_delete:
      StrCpy $FridayUnMode "delete"
    ${EndIf}
  ${EndIf}
FunctionEnd

!endif
