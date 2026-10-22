; Light Runner's additions to electron-builder's NSIS installer and uninstaller.

; electron-builder's own check for a running app needs these when it is wrapped by customCheckAppRunning.
!include "getProcessInfo.nsh"
Var pid

; Before the files are replaced, and before an uninstall: ask a running Light Runner to save the stage and stop,
; with its server (whose node.exe would otherwise keep its files in use). `Light Runner.exe --quit` returns once
; the launcher and the server have gone (at most about 25 s); it also stops a server left running without a launcher.
; Then electron-builder's usual check ends anything still running from the install folder.
!macro customCheckAppRunning
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping Light Runner (the stage is saved first)"
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
    Pop $0
  ${endIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

; Uninstalled (not updated): take Light Runner out of the programs Windows starts at login. The show, its backups
; and the settings in %APPDATA%\Light Runner stay.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Light Runner"
  ${endIf}
!macroend
