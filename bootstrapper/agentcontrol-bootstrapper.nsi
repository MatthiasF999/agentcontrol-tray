; AgentControl Windows bootstrapper  (Phase 63 / UI 63a / frameless 63b / light 66a)
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
; Win10/11. NSIS owns the light UI + a real, live progress bar fed from the
; worker's pct.txt. Only NSIS-bundled plugins (nsDialogs, System) are used ->
; builds anywhere makensis runs, including Linux CI. Zero third-party plugins.
;
; Phase 63b — Chrome-installer-style frameless window: the native caption is
; stripped (no title bar / title text / app icon), replaced by custom min +
; close buttons floating top-right, and the whole body is draggable.
;
; Why no live WndProc subclass: the NSIS System plugin's callbacks are
; single-threaded and only run while NSIS itself is parked inside a plugin
; call -- they cannot reliably service the OS-dispatched WindowProc messages
; that arrive during nsDialogs::Show. A half-working subclass that returns the
; wrong value for an unhandled message bricks the window, and this is only
; verifiable on Windows. So instead a cheap 30ms interaction timer polls the
; cursor + mouse-button state and drives hover, click, and drag itself. Same
; user-visible result (drag-from-anywhere except the two buttons, subtle
; button hover), zero third-party plugins, no risk of an unusable window.
; ---------------------------------------------------------------------------

Unicode true
ManifestDPIAware true
Name "AgentControl"
Caption " "            ; frameless -> never shown; blank as a belt-and-braces
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

; --- theme (light palette — DESIGN-GUIDE.md, "light-only by design") -------
; SetCtlColors takes 0xRRGGBB; progress-bar messages take COLORREF 0x00BBGGRR.
!define CLR_BG      0xFAFAFC   ; Colors.canvas    #FAFAFC  page background
!define CLR_TEXT    0x0A0A0F   ; Colors.textPrimary #0A0A0F strong ink (hover)
!define CLR_MUTED   0x6B7280   ; Colors.textMuted #6B7280 status / secondary
!define CLR_ACCENT  0x3E5FFF   ; Colors.accent    #3E5FFF brand + progress readout
!define CLR_ERR     0xEF4444   ; Colors.statusError #EF4444 error text
!define CLR_BTNHOVER 0xF6F7F9  ; Colors.subtle    #F6F7F9 button-hover surface
!define PB_BAR      0xFF5F3E   ; Colors.accent    #3E5FFF as BGR
!define PB_BK       0xF9F7F6   ; Colors.subtle    #F6F7F9 as BGR

; control styles
!define SS_CENTER_   0x00000001
!define SS_NOTIFY_   0x00000100
!define SS_CENTERIMAGE_ 0x00000200
!define WS_CHILD_    0x40000000
!define WS_VISIBLE_  0x10000000
; SetWindowPos: SWP_NOZORDER|SWP_NOACTIVATE
!define SWP_FLAGS    0x0014
; SetWindowPos: SWP_FRAMECHANGED|SWP_NOZORDER|SWP_NOACTIVATE (move+size kept)
!define SWP_FRAMED   0x0034

; frameless window manipulation  (GWL_STYLE comes from WinMessages.nsh)
!define WS_CAPTION_      0x00C00000
!define WS_CAPTION_MASK_ 0xFF3FFFFF   ; ~WS_CAPTION
!define WS_MINIMIZEBOX_  0x00020000
; WM_NCLBUTTONDOWN comes from WinMessages.nsh
!define HTCAPTION_       2
!define SW_MINIMIZE_     6
!define VK_LBUTTON_      1
!define VK_MENU_         0x12   ; Alt
!define VK_F4_           0x73

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
Var BtnMin
Var BtnClose
Var BtnFont
Var HotMin
Var HotClose
Var DragWasDown

Page custom BootPageShow

Function .onInit
  InitPluginsDir
FunctionEnd

; Strip the native caption (title bar + title text + window icon) so the
; window is frameless, keeping the minimize-box style bit. Then grow the
; window to WIN_W x WIN_H, recenter it on the primary monitor, and stretch
; the page-content placeholder (id 1018) to the full client area. Runs BEFORE
; nsDialogs::Create so the page dialog is sized to the enlarged placeholder.
Function ResizeWindow
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i ${GWL_STYLE})i.r0'
  IntOp $0 $0 & ${WS_CAPTION_MASK_}
  IntOp $0 $0 | ${WS_MINIMIZEBOX_}
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i ${GWL_STYLE}, i r0)'

  System::Call 'user32::GetSystemMetrics(i 0)i.r2'   ; SM_CXSCREEN
  System::Call 'user32::GetSystemMetrics(i 1)i.r3'   ; SM_CYSCREEN
  IntOp $2 $2 - ${WIN_W}
  IntOp $2 $2 / 2
  IntOp $3 $3 - ${WIN_H}
  IntOp $3 $3 / 2
  ; SWP_FRAMECHANGED so the stripped caption takes effect immediately.
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $2, i $3, i ${WIN_W}, i ${WIN_H}, i ${SWP_FRAMED})'
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

; Float the custom min + close buttons in the top-right corner (px coords).
Function PlaceButtons
  System::Call '*(i,i,i,i)p.r1'
  System::Call 'user32::GetClientRect(p $Dialog, p r1)'
  System::Call '*$1(i,i,i.r2,i)'                      ; r2 = client width
  System::Free $1
  IntOp $3 $2 - 34                                    ; close: 30px wide, 4px margin
  System::Call 'user32::SetWindowPos(p $BtnClose, p 0, i $3, i 4, i 30, i 22, i ${SWP_FLAGS})'
  IntOp $3 $3 - 32                                    ; min: left of close
  System::Call 'user32::SetWindowPos(p $BtnMin, p 0, i $3, i 4, i 30, i 22, i ${SWP_FLAGS})'
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
  CreateFont $BtnFont    "Segoe UI" "12" "400"

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

  ; --- frameless window buttons (custom min + close, floating top-right) ---
  nsDialogs::CreateControl STATIC \
    "${WS_CHILD_}|${WS_VISIBLE_}|${SS_NOTIFY_}|${SS_CENTER_}|${SS_CENTERIMAGE_}" "0" \
    0 0 30 22 "—"
  Pop $BtnMin
  SetCtlColors $BtnMin ${CLR_MUTED} ${CLR_BG}
  SendMessage $BtnMin ${WM_SETFONT} $BtnFont 1

  nsDialogs::CreateControl STATIC \
    "${WS_CHILD_}|${WS_VISIBLE_}|${SS_NOTIFY_}|${SS_CENTER_}|${SS_CENTERIMAGE_}" "0" \
    0 0 30 22 "✕"
  Pop $BtnClose
  SetCtlColors $BtnClose ${CLR_MUTED} ${CLR_BG}
  SendMessage $BtnClose ${WM_SETFONT} $BtnFont 1

  StrCpy $HotMin 0
  StrCpy $HotClose 0
  StrCpy $DragWasDown 1      ; swallow the launching click until first release
  Call PlaceButtons
  ${NSD_CreateTimer} UiTick 30

  File "/oname=$PLUGINSDIR\fetch.ps1" "fetch.ps1"
  Call StartWorker

  nsDialogs::Show
FunctionEnd

; 30ms interaction loop: drives button hover + click + drag-from-anywhere
; without a WndProc subclass (see header). Uses screen-coordinate hit-tests
; against the live control rects, so it stays correct after PlaceButtons.
Function UiTick
  ; --- native close (Alt+F4) belt-and-suspenders ---
  ; The caption is stripped so there is no system X, and a live WndProc
  ; subclass is deliberately avoided (see header). Poll Alt+F4 through the same
  ; GetAsyncKeyState timer path the click logic already relies on, so a
  ; keyboard close quits cleanly in every phase the window is up. (WM_CLOSE
  ; from the taskbar thumbnail menu still needs a subclass and is intentionally
  ; out of scope here — it is unverifiable on the Linux CI that builds this.)
  System::Call 'user32::GetAsyncKeyState(i ${VK_MENU_})i.r0'
  IntOp $0 $0 & 0x8000
  System::Call 'user32::GetAsyncKeyState(i ${VK_F4_})i.r1'
  IntOp $1 $1 & 0x8000
  ${If} $0 != 0
  ${AndIf} $1 != 0
    ${NSD_KillTimer} UiTick
    ${NSD_KillTimer} BootTick
    SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
    Return                                            ; WM_CLOSE posts, doesn't halt; stop the callback like Quit did
  ${EndIf}

  ; --- cursor position (screen coords) -> $6,$7 ---
  System::Call '*(i,i)p.r5'
  System::Call 'user32::GetCursorPos(p r5)'
  System::Call '*$5(i.r6,i.r7)'
  System::Free $5

  ; --- hover: minimize ---
  StrCpy $9 $BtnMin
  Call RectHit                                        ; -> $8
  ${If} $8 != $HotMin
    StrCpy $HotMin $8
    ${If} $8 == 1
      SetCtlColors $BtnMin ${CLR_TEXT} ${CLR_BTNHOVER}
    ${Else}
      SetCtlColors $BtnMin ${CLR_MUTED} ${CLR_BG}
    ${EndIf}
    System::Call 'user32::InvalidateRect(p $BtnMin, p 0, i 1)'
  ${EndIf}

  ; --- hover: close ---
  StrCpy $9 $BtnClose
  Call RectHit
  ${If} $8 != $HotClose
    StrCpy $HotClose $8
    ${If} $8 == 1
      SetCtlColors $BtnClose ${CLR_TEXT} ${CLR_BTNHOVER}
    ${Else}
      SetCtlColors $BtnClose ${CLR_MUTED} ${CLR_BG}
    ${EndIf}
    System::Call 'user32::InvalidateRect(p $BtnClose, p 0, i 1)'
  ${EndIf}

  ; --- left-button down-edge -> click a button or start a drag ---
  System::Call 'user32::GetAsyncKeyState(i ${VK_LBUTTON_})i.r0'
  IntOp $0 $0 & 0x8000
  ${If} $0 == 0
    StrCpy $DragWasDown 0
    Return
  ${EndIf}
  ${If} $DragWasDown == 1
    Return                                            ; still held; no new edge
  ${EndIf}
  StrCpy $DragWasDown 1

  ${If} $HotClose == 1
    ${NSD_KillTimer} UiTick
    ${NSD_KillTimer} BootTick
    SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
  ${ElseIf} $HotMin == 1
    System::Call 'user32::ShowWindow(p $HWNDPARENT, i ${SW_MINIMIZE_})'
  ${Else}
    ; drag only when the press is inside our window body
    StrCpy $9 $HWNDPARENT
    Call RectHit
    ${If} $8 == 1
      System::Call 'user32::ReleaseCapture()'
      SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} ${HTCAPTION_} 0
      StrCpy $DragWasDown 0                           ; move loop consumed the press
    ${EndIf}
  ${EndIf}
FunctionEnd

; Hit-test: is cursor ($6,$7 screen) inside window $9 ? -> $8 (1/0).
; Clobbers $0-$4.
Function RectHit
  System::Call '*(i,i,i,i)p.r4'
  System::Call 'user32::GetWindowRect(p r9, p r4)'
  System::Call '*$4(i.r0,i.r1,i.r2,i.r3)'             ; l,t,r,b
  System::Free $4
  ${If} $6 >= $0
  ${AndIf} $6 < $2
  ${AndIf} $7 >= $1
  ${AndIf} $7 < $3
    StrCpy $8 1
  ${Else}
    StrCpy $8 0
  ${EndIf}
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
    ${NSD_KillTimer} UiTick
    SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
    Return                                            ; else falls through into retry: -> StartWorker on cancel
    retry:
      Call StartWorker
  ${EndIf}
  ; empty/partial result.txt: leave timer running, retry next tick
FunctionEnd

; Hand off to the real signed installer, silently, then exit. The Tauri
; POSTINSTALL hook launches the tray + onboarding, so no further UI here.
; A bootstrapper invoked with /S stays silent through the whole chain.
;
; Fire-and-forget (Exec, not ExecWait): the child runs silent (/S) and owns
; every bit of the remaining UX, so the bootstrapper has no post-hand-off job
; and must NOT block. ExecWait blocked the NSIS thread for the whole silent
; install while UiTick was already killed above -> the window froze at
; "Starting installer..." with a dead custom X, killable only via Task Manager
; (the reported bug). The child exit code was captured into $0 but never read,
; so waiting bought no error handling either. Exec returns once the child image
; is mapped (the loader locks the .exe), so the running installer survives this
; process's $PLUGINSDIR cleanup on Quit; the Tauri installer extracts to its
; own temp dir and needs nothing further from ours.
Function RunChild
  ${NSD_KillTimer} UiTick
  ${If} $ChildExe == ""
    MessageBox MB_ICONSTOP|MB_OK "Internal error: installer path missing."
    SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
    Return                                            ; else falls through into Exec of the empty path
  ${EndIf}
  Exec '"$ChildExe" /S'
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
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
