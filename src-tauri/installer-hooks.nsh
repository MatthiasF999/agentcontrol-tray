; Tauri 2 NSIS installer hooks for AgentControl Tray.
;
; WebView2 is handled by Tauri's own `Section WebView2` (which runs before
; `Section Install`, where this POSTINSTALL hook fires): it detects the
; Evergreen runtime via the `pv` regkey, and when missing downloads
; Microsoft's bootstrapper (https://go.microsoft.com/fwlink/p/?LinkId=2124703)
; and runs it silently, Abort-ing the install on failure. That behaviour is
; pinned explicitly in tauri.conf.json (bundle.windows.webviewInstallMode =
; downloadBootstrapper, silent). We deliberately do NOT re-implement that
; download here — doing so would duplicate Tauri's section and risk a
; double install.
;
; POSTINSTALL does two things:
;   1. Launch-gate — re-verify the WebView2 `pv` regkey (HKLM per-machine /
;      HKCU per-user, matching Tauri's detection). If the runtime is somehow
;      still absent, launching the tray would only show a blank webview, so
;      we surface a friendly message and skip the auto-launch instead.
;   2. On success, launch the tray binary so the icon + onboarding wizard
;      appear the moment the user clicks Finish. $INSTDIR is the install root.

!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!macro NSIS_HOOK_POSTINSTALL
  Push $0
  ${If} ${RunningX64}
    ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${Else}
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}

  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "AgentControl needs the Microsoft Edge WebView2 runtime, which could not be installed automatically.$\r$\n$\r$\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/ and then start AgentControl from the Start Menu."
  ${Else}
    Exec '"$INSTDIR\agentcontrol-tray.exe"'
  ${EndIf}
  Pop $0
!macroend
