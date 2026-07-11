# Windows-Sandbox installer test harness (Phase 66d)

Automated end-to-end test of the AgentControl tray installer. Every run gets a
**clean, disposable Windows OS** (Windows Sandbox), drives the installer,
screenshots each step, and verifies the install artifacts + tray launch — then
throws the OS away. No residue on the host, no VM to maintain.

Two flows exist, selected with `--flow`:

| Flow   | .wsb           | Covers | Budget |
|--------|----------------|--------|--------|
| `tray` (default) | `test.wsb`     | installer download + tray launch (Windows-side only) | ~2–3 min |
| `wsl`  | `test-wsl.wsb` | full bootstrapper: WSL2 kernel + Ubuntu-22.04 + `wsl.sh` bridge install | ~15 min |
| `full` | both           | `tray` first, then `wsl` **only if tray passed** | ~18 min |

Use `tray` for fast installer smoke; use `wsl`/`full` for **pre-release** smoke
of the whole install story. The WSL flow is too slow (~15 min, needs nested
virt) for iterative dev — reach for it before cutting a release, not per commit.

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
| `host-orchestrator.sh`   | WSL   | Stage inputs, launch sandbox(es), read result back. `--flow tray\|wsl\|full`. |
| `test.wsb`               | host  | Tray-flow sandbox config (RAM, net, mapped folders, LogonCommand). |
| `test-wsl.wsb`           | host  | WSL-flow config: 8 GB RAM + `ProtectedClient=Disable` for nested virt. |
| `sandbox-runner.ps1`     | sandbox | Tray flow: walks the install, verifies artifacts, writes `result.json`. |
| `sandbox-runner-wsl.ps1` | sandbox | WSL flow: installs kernel + Ubuntu + bridge, writes `result.json`. |
| `helpers.psm1`           | sandbox | UIAutomation + screenshot + result helpers (shared). |

## Prerequisites

- **Windows 11 Pro / Enterprise / Education** (Sandbox is not on Home).
- **Windows Sandbox feature enabled**:
  `Enable-WindowsOptionalFeature -FeatureName Containers-DisposableClientVM -Online`
  (or *Turn Windows features on or off → Windows Sandbox*), then reboot.
- **WSL** with `curl` (for the download path) — this repo already lives in WSL.
- Virtualization enabled in BIOS.

**WSL flow (`--flow wsl` / `full`) additionally needs:**

- **Windows 11 24H2 or newer** (build **26100+**). Nested virtualization inside
  Windows Sandbox is unlocked by `<ProtectedClient>Disable</ProtectedClient>`
  in `test-wsl.wsb`, and that element is only honoured on 24H2+. On older builds
  WSL2 cannot start inside the sandbox — the runner records step
  `nested_virt_unsupported`, dumps `output/diagnostics.txt`, and reports
  `pass: false` (see *Fallback* below).
- **Nested-virt-capable host** — the physical CPU has virtualization enabled and
  the host isn't itself a VM that blocks nesting.
- Ideally run from an **admin** shell so the diagnostics dump can read
  `Get-WindowsOptionalFeature` / Hyper-V event logs (it degrades gracefully if
  not).

## Running

From WSL, inside `scripts/sandbox-test/`:

```bash
./host-orchestrator.sh                    # tray flow, live bootstrapper setup.exe
./host-orchestrator.sh --local ./setup.exe   # tray flow, locally-built installer
./host-orchestrator.sh --keep-sandbox     # leave the sandbox open for debugging
./host-orchestrator.sh --flow wsl         # full WSL2 + Ubuntu + bridge (~15 min)
./host-orchestrator.sh --flow full        # tray then wsl, in sequence (~18 min)
```

Exit code is `0` on pass, `1` on fail. The full `result.json` is printed. For
`--flow full` each leg is also copied aside to `result-tray.json` /
`result-wsl.json`, and the wsl leg only runs if the tray leg passed.

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

## The WSL flow (`--flow wsl`)

`sandbox-runner-wsl.ps1` drives the **whole** bootstrapper story that a real
user hits, inside a throwaway OS:

1. `verify-host` — Windows caption + build; warns if `< 26100` (nested virt).
2. `install-kernel` — `wsl --install --no-distribution --no-launch`. `--no-launch`
   installs the kernel **without** triggering the reboot dialog, so the run
   stays unattended.
3. `wait-kernel` — polls `wsl --status` until the kernel is installed (≤5 min).
4. `install-distro` — `wsl --install -d Ubuntu-22.04 --no-launch`.
5. `wait-distro` — polls `wsl --list --quiet` until `Ubuntu-22.04` registers.
6. `install-bridge` — `wsl -d Ubuntu-22.04 -u root … curl -sSL …/wsl.sh | bash`.
   Running as **`-u root`** bypasses the first-run `NewUserPrompt` (no default
   UNIX user has been created), keeping the run non-interactive.
7. `verify-bridge` — `systemctl --user status agentcontrol-bridge`; falls back to
   a `pgrep` process check (recorded as `warn`) since `--user` systemd may be
   unavailable without a created default user.

Each phase screenshots to `output/screenshots/` and appends to `result.json`.
`WSL_UTF8=1` is set so `wsl.exe`'s normally-UTF-16LE output parses cleanly.

`result.json` for this flow adds `distro`, `windowsBuild`, `nestedVirtSupported`,
and (on failure) a `diagnostics` path.

## Fallback: nested virt unavailable

If `wsl --install` fails with a virtualization / hypervisor error (e.g.
`0x80370102`, "Virtual Machine Platform"), the runner:

- records a step named **`nested_virt_unsupported`** (`status: fail`) and sets
  `nestedVirtSupported: false`, `pass: false`;
- writes `output/diagnostics.txt` — `wsl --status/--version/--list`, the Windows
  version, `VirtualizationFirmwareEnabled` / `HypervisorPresent` /
  `VirtualMachinePlatform` state, and recent Hyper-V/WSL System-log events — so
  you can see **why** nesting was refused.

Most often the fix is simply **upgrade the host to Windows 11 24H2+**. If the
host genuinely can't nest a hypervisor (older Windows, or a cloud VM that blocks
nesting), test the WSL flow in a **real Hyper-V VM with nested virt enabled**
(`Set-VMProcessor -ExposeVirtualizationExtensions $true`) instead of Sandbox —
tracked as a future issue (link TODO) rather than built here.

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
Then run `./host-orchestrator.sh --flow wsl` on a **24H2+** host to smoke the
full WSL install path (budget ~15 min); if it reports `nested_virt_unsupported`,
see *Fallback* above.
