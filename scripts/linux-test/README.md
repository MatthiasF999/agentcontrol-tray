# Linux test harness (Phase 66e)

Docker-first companion to the Windows-Sandbox harness (`scripts/sandbox-test/`).
Every run gets a **fresh, disposable Ubuntu container**, drives the real public
installer, verifies the artifacts, and throws the container away. Works
cross-OS: native Linux, **WSL2**, and macOS **Docker Desktop**.

```
host-orchestrator.sh  (host)                Ubuntu container (clean, disposable)
  docker build ─────────────────────────►   Flow A: /sbin/init (systemd)
  docker run  ──────volume /output──────►      bridge-runner.sh: curl wsl.sh | bash
  docker exec bridge-runner.sh ─────────►      verify unit + /health + backend
  read output/<flow>/result.json ◄──────       write result.json + journal log
  print summary, exit 0/1                      (Flow B: xvfb + xdotool tray smoke)
```

## Files

| File | Runs on | Purpose |
|------|---------|---------|
| `host-orchestrator.sh` | host | Build images, run containers, read result back. `--flow bridge\|tray\|both`. |
| `Dockerfile.bridge` | — | Flow A image: booting **systemd** Ubuntu + node + installer deps. |
| `bridge-runner.sh` | container | Install bridge, verify `systemctl --user` unit + `/health` + backend. |
| `Dockerfile.tray` | — | Flow B image: xvfb + xdotool + WebKitGTK + panel. |
| `tray-runner.sh` | container | Launch tray under virtual X, screenshot, walk pair window. |

## Prerequisites

- **Docker** (native `docker`, Docker Desktop on macOS/Windows, or docker in
  WSL2). That's it — no Node/Rust on the host.
- Flow A needs `--privileged` (the orchestrator passes it) because the real
  installer registers a **systemd** service; a booting init + cgroup mount are
  required. On Docker Desktop this works out of the box.

## Running

```bash
./host-orchestrator.sh --flow bridge   # priority-1, CI-friendly
./host-orchestrator.sh --flow tray     # best-effort UI smoke
./host-orchestrator.sh                  # both
./host-orchestrator.sh --flow bridge --keep   # leave container up to debug
```

Exit code is `0` when every requested flow reports `pass: true`.

## Where output lands

Per-flow under `scripts/linux-test/output/<flow>/`:

- `result.json` — `{ flow, pass, steps[], ... }`
- `logs/` (bridge) — `install.log`, `journal-agentcontrol-bridge.log` (the
  text-log analogue of the Windows harness's screenshots).
- `screenshots/NNN-label.png` (tray).

Sample `result.json` (Flow A):

```json
{
  "flow": "bridge",
  "pass": true,
  "steps": [
    { "name": "user-manager",       "status": "pass", "detail": "user systemd session live" },
    { "name": "install-bridge",     "status": "pass", "detail": "wsl.sh completed" },
    { "name": "unit-active",        "status": "pass", "detail": "systemctl --user: agentcontrol-bridge active" },
    { "name": "local-health",       "status": "pass", "detail": "http://localhost:3000/health -> {\"ok\":true}" },
    { "name": "backend-reachable",  "status": "pass", "detail": "https://api.agent-control.io/health -> {\"ok\":true}" }
  ],
  "logs": "logs/",
  "startedUtc": "2026-07-11T21:00:00Z",
  "finishedUtc": "2026-07-11T21:02:40Z"
}
```

## Two landmines this harness works around (read before editing)

### 1. The installer is WSL2-only-guarded

`wsl.sh` hard-exits unless `/proc/version` contains `microsoft`. A plain Ubuntu
container fails that guard. `bridge-runner.sh` (phase 1, as root) **bind-mounts
a WSL-looking `/proc/version`** to pass it — this needs `--privileged` and
reverts on teardown. If the installer ever gains a real native-Linux entry
point (`deploy/` in the bridge repo), switch to that and drop the spoof.

### 2. The bridge unit is a `systemctl --user` service, not a system one

`wsl.sh` writes `~/.config/systemd/user/agentcontrol-bridge.service` and drives
it with `systemctl --user` + `loginctl enable-linger` + `journalctl --user` —
**not** a system unit. So the container must:

- boot `/sbin/init` (systemd as PID 1) — hence the privileged image;
- run the install as a **non-root user** with **linger enabled** (the Dockerfile
  touches `/var/lib/systemd/linger/actest`) so `user@<uid>.service` starts that
  user's `systemd --user` manager at boot;
- have `bridge-runner.sh` export `XDG_RUNTIME_DIR` + `DBUS_SESSION_BUS_ADDRESS`
  so `systemctl --user` reaches the running manager.

If `unit-active` fails with "no systemd --user bus", the user manager didn't
start — check linger and that the container booted init (not the runner
directly).

## Flow A vs the brief

Steps done: install → unit active → local `/health` → backend `/health`
reachable. **Pairing to an org is _not_ automated** — it needs an interactive
claim code (`curl localhost:3000/pair`), so `backend-reachable` only proves the
bridge can talk to `api.agent-control.io`. Full pair-flow is a follow-up (feed a
test-org claim code via env). Note the port is **3000** (wsl.sh default), not
3001.

## Flow B caveats (best-effort — follow-up work)

Flow B is priority-2 and known-flaky headless:

- **No StatusNotifier host under bare xvfb.** A Tauri `ayatana-appindicator`
  tray icon has nowhere to dock without a StatusNotifierWatcher. The image
  installs `xfce4-panel` to provide one, but SNI-over-xvfb is finicky; the tray
  *window* may map while the *icon* never appears. `walk-pair` therefore
  **skips** rather than fails when no window is found.
- **Deb URL is assumed.** `tray-runner.sh` fetches `install.agent-control.io/tray.deb`
  (override with `DEB_URL=`). The bundle also ships an **AppImage**
  (`tauri.conf.json` targets `deb` + `appimage`); if the install host serves the
  AppImage instead, point `DEB_URL` at it and swap the install step for a
  `chmod +x && ./x.AppImage --appimage-extract`-style launch.
- **Package name / deps**: deb is `agentcontrol-tray_<ver>_amd64.deb`, binary
  `agentcontrol-tray`; runtime depends `libwebkit2gtk-4.1-0` +
  `libayatana-appindicator3-1` (mirrored in the image).

## Adding a test step

1. Add a `step_xxx` (bridge) / `xxx` (tray) function — keep it small.
2. Call `add_step <name> <pass|fail|skip> <detail>`; `shot <label>` for tray
   screenshots.
3. Wire it into `main`. A hard failure returns non-zero → flips `pass` to false
   but the run still writes `result.json`.

## Not yet executed

Per the Phase 66e brief these scripts were **syntax-checked only** (`bash -n` +
Dockerfile review) — no `docker build`/`run` yet. First smoke test: run
`./host-orchestrator.sh --flow bridge` on a Docker host and confirm
`output/bridge/result.json` reports `pass: true`.
