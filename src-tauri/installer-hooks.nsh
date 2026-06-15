; Tauri 2 NSIS installer hooks for AgentControl Tray.
;
; POSTINSTALL: launch the tray binary after the installer copies files.
; This avoids the "install → click Start Menu → click app" round-trip;
; the moment the user clicks Finish, the tray icon appears in the
; system tray and the onboarding wizard starts (first-run gate
; routes to it). $INSTDIR is the install root populated by Tauri.

!macro NSIS_HOOK_POSTINSTALL
  Exec '"$INSTDIR\agentcontrol-tray.exe"'
!macroend
