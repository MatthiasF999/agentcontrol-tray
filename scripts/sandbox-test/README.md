# Windows-Sandbox installer test harness (Phase 66d)

Automated end-to-end test of the AgentControl tray installer. Every run gets a
**clean, disposable Windows OS** (Windows Sandbox), drives the installer,
screenshots each step, and verifies the install artifacts + tray launch — then
throws the OS away. No residue on the host, no VM to maintain.

```
host-orchestrator.sh  (WSL)                Windows Sandbox (clean OS)
  stage setup.exe + *.ps1  ──MappedFolder─►  LogonCommand: sandbox-runner.ps1
  launch test.wsb  ─────────────────────►      launch setup.exe
  poll output/result.json  ◄──MappedFolder──   drive install + screenshot
  print summary, exit 0/1                       write result.json, Stop-Computer
```

## Files

| File                 | Runs on | Purpose |
|----------------------|---------|---------|
| `host-orchestrator.sh` | WSL   | Stage inputs, launch sandbox, read result back. |
| `test.wsb`             | host  | Sandbox config (RAM, net, mapped folders, LogonCommand). |
| `sandbox-runner.ps1`   | sandbox | Walks the install, verifies artifacts, writes `result.json`. |
| `helpers.psm1`         | sandbox | UIAutomation + screenshot + result helpers. |

## Prerequisites

- **Windows 11 Pro / Enterprise / Education** (Sandbox is not on Home).
- **Windows Sandbox feature enabled**:
  `Enable-WindowsOptionalFeature -FeatureName Containers-DisposableClientVM -Online`
  (or *Turn Windows features on or off → Windows Sandbox*), then reboot.
- **WSL** with `curl` (for the download path) — this repo already lives in WSL.
- Virtualization enabled in BIOS.

## Running

From WSL, inside `scripts/sandbox-test/`:

```bash
./host-orchestrator.sh                    # download the live bootstrapper setup.exe
./host-orchestrator.sh --local ./setup.exe   # test a locally-built installer
./host-orchestrator.sh --keep-sandbox     # leave the sandbox open for debugging
```

Exit code is `0` on pass, `1` on fail. The full `result.json` is printed.

## Where output lands

Everything is on the **host** at `C:\Users\Dev\AgentControlSandbox\output`
(`/mnt/c/Users/Dev/AgentControlSandbox/output` from WSL):

- `result.json` — `{ pass, installDir, steps[], errors[] }`
- `screenshots/NNN-label.png` — one per step, plus `NNN-final.png`.

Sample `result.json`:

```json
{
  "pass": true,
  "installDir": "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\agentcontrol-tray",
  "steps": [
    { "name": "verify-setup-present", "status": "pass", "detail": "found ...\\setup.exe", "screenshot": "...\\001-pre-launch.png" },
    { "name": "launch-installer",     "status": "pass", "detail": "setup.exe started" },
    { "name": "find-window",          "status": "skip", "detail": "no wizard window (self-driving/silent)" },
    { "name": "verify-install-dir",   "status": "pass", "detail": "C:\\...\\agentcontrol-tray" },
    { "name": "launch-tray",          "status": "pass", "detail": "pid 4812" }
  ],
  "errors": [],
  "startedUtc": "2026-07-11T09:00:00.000Z",
  "finishedUtc": "2026-07-11T09:02:41.000Z"
}
```

`status` is `pass` / `fail` / `skip`. A `skip` on the wizard steps is **normal**
— see below.

## The two installer shapes (important)

The public `setup.exe` at `install.agent-control.io` is a **frameless
bootstrapper**, *not* the classic NSIS wizard. It shows its own custom progress
window, downloads the real signed `agentcontrol-tray_<ver>_x64-setup.exe`, and
runs it **silently (`/S`)**. So there is **no** "Next / Install / Finish" wizard
to click — the `find-window` / `click-*` steps will report `skip`, and success
is decided purely by the install dir + tray process appearing.

The wizard-walking logic still exists for the `--local` path, in case you point
it at a **real** `*-setup.exe` run non-silently. That standard Tauri NSIS
installer's buttons are **English by default** ("Next", "Install", "Finish") —
`tauri.conf.json` sets no `languages` key, so despite the internal brief the
labels are *not* German. `Find-Button` is fed both English **and** German
candidates so either build works; add more locales to the `*Names` arrays in
`sandbox-runner.ps1` as needed.

## Adding a new test step

1. Add a `Step-Xxx` function in `sandbox-runner.ps1` (keep it small — the repo's
   50-line function limit is a good target even though it's not enforced on
   `.ps1`).
2. Call `Add-Step <name> <pass|fail|skip> <detail> <screenshotPath>` inside it,
   and `Save-Screenshot <label>` where a visual helps.
3. Invoke it from the `try` block in the run section, in order.
4. Let a real failure `throw` — the top-level `catch` records the error,
   screenshots `error`, and still writes `result.json`.

## Debugging when UIAutomation can't find a button

- Run with `--keep-sandbox`, then inside the sandbox open **`inspect.exe`**
  (Windows SDK Accessibility Insights / Inspect) and hover the button to read
  its exact **Name** and **ControlType**.
- NSIS accelerators (`&`) and surrounding whitespace are already stripped by
  `Find-Button`; a mismatch usually means a different **locale** or a
  non-Button control type — add the exact Name to the candidate array.
- Check the numbered screenshots: they show what the UI actually looked like at
  each step, which quickly reveals a wrong window title or an unexpected dialog
  (e.g. a WebView2 install prompt).
- The bootstrapper's frameless window has **no** standard buttons at all — if
  you need to assert on it, match its window title and screenshot rather than
  hunting for buttons.

## First run

This has **not** been executed against a live sandbox yet (it needs Windows-side
execution). First smoke test: run `./host-orchestrator.sh` on the Windows host
and confirm `result.json` reports `pass: true` and the screenshots look right.
