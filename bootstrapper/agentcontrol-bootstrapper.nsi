; AgentControl Windows bootstrapper  (Phase 63 / UI polish 63a)
; ---------------------------------------------------------------------------
; A tiny, version-stable installer entry point. ONE URL
;   https://install.agent-control.io/setup.exe
; always installs the latest tray. It reads latest.json, downloads the real
; signed Tauri NSIS installer, SHA256-verifies it, and hands off with /S.
; Post-install upgrades are handled by the Tauri updater (Phase 27.7).
;
; Design note: the stock NSIS toolchain on the build host ships no INetC /
; Crypto / nsJSON plugins, and the bundled NSISdl cannot do HTTPS. So the
; three plugin-shaped jobs (TLS download, JSON parse, SHA256) are delegated
; to a hidden PowerShell worker (fetch.ps1) that is present on every
; Win10/11. NSIS owns the dark UI + a real, live progress bar fed from the
; worker's pct.txt. Only NSIS-bundled plugins (nsDialogs, System) are used ->
; builds anywhere makensis runs, including Linux CI. Zero third-party plugins.
; ---------------------------------------------------------------------------

Unicode true
ManifestDPIAware true
Name "AgentControl"
Caption "AgentControl Setup"
OutFile "agentcontrol-bootstrapper.exe"
; Tauri installs per-user (currentUser) -> no admin, no UAC prompt.
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText " "
XPStyle off            ; classic controls so PBM_SET*COLOR is honored

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define MANIFEST_URL "https://install.agent-control.io/latest.json"

; --- window geometry (px) -------------------------------------------------
!define WIN_W 480
!define WIN_H 360

; --- theme (tray palette) -------------------------------------------------
; SetCtlColors takes 0xRRGGBB; progress-bar messages take COLORREF 0x00BBGGRR.
!define CLR_BG      0x0E1116   ; #0e1116 background
!define CLR_TEXT    0xF1F5F9   ; #f1f5f9 primary text
!define CLR_MUTED   0x94A3B8   ; #94a3b8 secondary text
!define CLR_ACCENT  0x818CF8   ; #818cf8 brand accent
!define CLR_ERR     0xF87171   ; #f87171 error text
!define PB_BAR      0xE5464F   ; #4f46e5 as BGR
!define PB_BK       0x16110E   ; #0e1116 as BGR

; control styles
!define SS_CENTER_   0x00000001
!define WS_CHILD_    0x40000000
!define WS_VISIBLE_  0x10000000
; SetWindowPos: SWP_NOZORDER|SWP_NOACTIVATE
!define SWP_FLAGS    0x0014

!ifndef PBM_SETRANGE32
  !define PBM_SETRANGE32  0x406
!endif
!ifndef PBM_SETPOS
  !define PBM_SETPOS      0x402
!endif
!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR  0x2001
!endif
!ifndef PBS_SMOOTH
  !define PBS_SMOOTH      0x01
!endif

Var Dialog
Var LblBrand
Var LblStatus
Var LblPct
Var ProgBar
Var IconCtl
Var IconHandle
Var ChildExe
Var BrandFont
Var StatusFont
Var PctFont

Page custom BootPageShow

Function .onInit
  InitPluginsDir
FunctionEnd

; Grow the whole installer window to WIN_W x WIN_H and recenter it on the
; primary monitor, then stretch the page-content placeholder (id 1018) to
; cover the full client area. Must run BEFORE nsDialogs::Create so the page
; dialog is sized to the enlarged placeholder.
Function ResizeWindow
  System::Call 'user32::GetSystemMetrics(i 0)i.r2'   ; SM_CXSCREEN
  System::Call 'user32::GetSystemMetrics(i 1)i.r3'   ; SM_CYSCREEN
  IntOp $2 $2 - ${WIN_W}
  IntOp $2 $2 / 2
  IntOp $3 $3 - ${WIN_H}
  IntOp $3 $3 / 2
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $2, i $3, i ${WIN_W}, i ${WIN_H}, i ${SWP_FLAGS})'
  GetDlgItem $0 $HWNDPARENT 1018
  System::Call 'user32::SetWindowPos(p $0, p 0, i 0, i 0, i ${WIN_W}, i ${WIN_H}, i ${SWP_FLAGS})'
FunctionEnd

; Center the icon control horizontally within the page dialog (px coords).
Function CenterIcon
  System::Call '*(i,i,i,i)p.r1'                       ; alloc RECT
  System::Call 'user32::GetClientRect(p $Dialog, p r1)'
  System::Call '*$1(i,i,i.r2,i)'                      ; r2 = right (client width)
  System::Free $1
  IntOp $2 $2 - 64
  IntOp $2 $2 / 2
  System::Call 'user32::SetWindowPos(p $IconCtl, p 0, i $2, i 34, i 64, i 64, i ${SWP_FLAGS})'
FunctionEnd

Function BootPageShow
  Call ResizeWindow

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}
  SetCtlColors $Dialog ${CLR_TEXT} ${CLR_BG}

  ; This page does all the work; the wizard chrome buttons stay hidden.
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}

  CreateFont $BrandFont  "Segoe UI" "20" "700"
  CreateFont $StatusFont "Segoe UI" "9"  "400"
  CreateFont $PctFont    "Segoe UI" "9"  "700"

  ; --- app icon (centered above the title) ---
  File "/oname=$PLUGINSDIR\icon64.bmp" "icon64.bmp"
  ${NSD_CreateBitmap} 0 34u 64 64 ""
  Pop $IconCtl
  SetCtlColors $IconCtl ${CLR_TEXT} ${CLR_BG}
  ${NSD_SetImage} $IconCtl "$PLUGINSDIR\icon64.bmp" $IconHandle
  Call CenterIcon

  ; --- brand title (centered) ---
  nsDialogs::CreateControl STATIC \
    "${WS_CHILD_}|${WS_VISIBLE_}|${SS_CENTER_}" "0" \
    0 96u 100% 26u "AgentControl"
  Pop $LblBrand
  SetCtlColors $LblBrand ${CLR_ACCENT} ${CLR_BG}
  SendMessage $LblBrand ${WM_SETFONT} $BrandFont 1

  ; --- status line (centered) ---
  nsDialogs::CreateControl STATIC \
    "${WS_CHILD_}|${WS_VISIBLE_}|${SS_CENTER_}" "0" \
    0 132u 100% 12u "Connecting..."
  Pop $LblStatus
  SetCtlColors $LblStatus ${CLR_MUTED} ${CLR_BG}
  SendMessage $LblStatus ${WM_SETFONT} $StatusFont 1

  ; --- progress bar (inset, centered) ---
  ; nsDialogs has no progress-bar primitive; create the native control
  ; directly. CreateControl honours the same dialog-unit / percent coords
  ; as the NSD_* macros and parents it to the page for us.
  nsDialogs::CreateControl "msctls_progress32" \
    "${PBS_SMOOTH}|${WS_CHILD_}|${WS_VISIBLE_}" "0" \
    10% 150u 80% 8u ""
  Pop $ProgBar
  SendMessage $ProgBar ${PBM_SETRANGE32} 0 100
  SendMessage $ProgBar ${PBM_SETBARCOLOR} 0 ${PB_BAR}
  SendMessage $ProgBar ${PBM_SETBKCOLOR} 0 ${PB_BK}

  ; --- percent readout under the bar (centered) ---
  nsDialogs::CreateControl STATIC \
    "${WS_CHILD_}|${WS_VISIBLE_}|${SS_CENTER_}" "0" \
    0 164u 100% 12u ""
  Pop $LblPct
  SetCtlColors $LblPct ${CLR_ACCENT} ${CLR_BG}
  SendMessage $LblPct ${WM_SETFONT} $PctFont 1

  File "/oname=$PLUGINSDIR\fetch.ps1" "fetch.ps1"
  Call StartWorker

  nsDialogs::Show
FunctionEnd

; Launch (or relaunch, on retry) the hidden PowerShell worker. Clears any
; stale handshake files first, then arms the polling timer.
Function StartWorker
  Delete "$PLUGINSDIR\result.txt"
  Delete "$PLUGINSDIR\pct.txt"
  Delete "$PLUGINSDIR\phase.txt"
  Delete "$PLUGINSDIR\error.txt"
  Delete "$PLUGINSDIR\path.txt"
  Delete "$PLUGINSDIR\version.txt"
  SendMessage $ProgBar ${PBM_SETPOS} 0 0
  SetCtlColors $LblStatus ${CLR_MUTED} ${CLR_BG}
  ${NSD_SetText} $LblStatus "Connecting..."
  ${NSD_SetText} $LblPct ""
  Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\fetch.ps1" -ManifestUrl "${MANIFEST_URL}" -WorkDir "$PLUGINSDIR"'
  ${NSD_CreateTimer} BootTick 250
FunctionEnd

Function BootTick
  ${IfNot} ${FileExists} "$PLUGINSDIR\result.txt"
    ${If} ${FileExists} "$PLUGINSDIR\pct.txt"
      Call ReadPct
      SendMessage $ProgBar ${PBM_SETPOS} $1 0
      ${If} $1 > 0
        ${NSD_SetText} $LblPct "$1%"
      ${EndIf}
    ${EndIf}
    ${If} ${FileExists} "$PLUGINSDIR\phase.txt"
      Push "$PLUGINSDIR\phase.txt"
      Call ReadLine
      Pop $1
      ${NSD_SetText} $LblStatus $1
    ${EndIf}
    Return
  ${EndIf}

  Push "$PLUGINSDIR\result.txt"
  Call ReadLine
  Pop $1
  ${If} $1 == "DONE"
    ${NSD_KillTimer} BootTick
    Push "$PLUGINSDIR\path.txt"
    Call ReadLine
    Pop $ChildExe
    SendMessage $ProgBar ${PBM_SETPOS} 100 0
    ${NSD_SetText} $LblPct "100%"
    ${NSD_SetText} $LblStatus "Starting installer..."
    Call RunChild
  ${ElseIf} $1 == "ERR"
    ${NSD_KillTimer} BootTick
    Push "$PLUGINSDIR\error.txt"
    Call ReadLine
    Pop $1
    SetCtlColors $LblStatus ${CLR_ERR} ${CLR_BG}
    ${NSD_SetText} $LblStatus "Failed: $1"
    MessageBox MB_ICONSTOP|MB_RETRYCANCEL "AgentControl could not be installed.$\n$\n$1" IDRETRY retry
    Quit
    retry:
      Call StartWorker
  ${EndIf}
  ; empty/partial result.txt: leave timer running, retry next tick
FunctionEnd

; Hand off to the real signed installer, silently, then exit. The Tauri
; POSTINSTALL hook launches the tray + onboarding, so no further UI here.
; A bootstrapper invoked with /S stays silent through the whole chain.
Function RunChild
  ${If} $ChildExe == ""
    MessageBox MB_ICONSTOP|MB_OK "Internal error: installer path missing."
    Quit
  ${EndIf}
  ExecWait '"$ChildExe" /S' $0
  Quit
FunctionEnd

; Read a whole single-line file (worker writes them without trailing newline)
; and strip any stray CR/LF. Input: path on stack. Output: value on stack.
Function ReadLine
  Exch $2
  Push $3
  ClearErrors
  FileOpen $3 $2 r
  ${If} ${Errors}
    StrCpy $2 ""
  ${Else}
    FileRead $3 $2
    FileClose $3
  ${EndIf}
  Push $2
  Call TrimCRLF
  Pop $2
  Pop $3
  Exch $2
FunctionEnd

; pct.txt -> integer in $1
Function ReadPct
  Push "$PLUGINSDIR\pct.txt"
  Call ReadLine
  Pop $1
  ${If} $1 == ""
    StrCpy $1 "0"
  ${EndIf}
FunctionEnd

; strip trailing CR/LF from string on stack
Function TrimCRLF
  Exch $0
  Push $1
  loop:
    StrCpy $1 $0 1 -1
    ${If} $1 == "$\r"
    ${OrIf} $1 == "$\n"
      StrCpy $0 $0 -1
      Goto loop
    ${EndIf}
  Pop $1
  Exch $0
FunctionEnd

Section
SectionEnd
