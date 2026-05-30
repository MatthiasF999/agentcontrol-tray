# Phase 27.7 — Auto-update operator setup

Tauri's updater plugin verifies update bundles against an Ed25519 signing
key. Phase 27.7 ships the plugin wired up + UI; the **signing keypair**
generation + release-publishing flow are operator-actions.

## One-time setup (operator)

1. Generate a signing keypair:

   ```bash
   pnpm tauri signer generate -w ~/.tauri/agentcontrol-tray.key
   ```

   This produces `~/.tauri/agentcontrol-tray.key` (private — keep secret)
   and prints the **public key** to stdout. Copy it.

2. Paste the public key into `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`, replacing the placeholder
   `"REPLACE_WITH_TAURI_SIGNER_PUBKEY_PHASE_27_7_OPERATOR_ACTION"`.

3. Commit the conf change. Do NOT commit the private key.

## Per-release flow

When publishing a new release on GitHub:

1. Build the platform-native bundle(s):
   ```bash
   pnpm tauri build
   ```
   Artifacts land in `src-tauri/target/release/bundle/{linux,macos,windows}/`.

2. Sign each platform's primary update artifact:
   ```bash
   TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/agentcontrol-tray.key) \
     pnpm tauri signer sign <path-to-bundle>
   ```
   Produces `<bundle>.sig`.

3. Upload to a GitHub release tagged `v<semver>`:
   - The bundles themselves
   - A `latest.json` manifest in this shape:
     ```json
     {
       "version": "0.1.1",
       "notes": "What changed in this release",
       "pub_date": "2026-06-01T00:00:00Z",
       "platforms": {
         "linux-x86_64": {
           "signature": "<contents of bundle.sig>",
           "url": "https://github.com/.../releases/download/v0.1.1/agentcontrol-tray_0.1.1_amd64.AppImage"
         },
         "darwin-x86_64":  { "signature": "...", "url": "..." },
         "darwin-aarch64": { "signature": "...", "url": "..." },
         "windows-x86_64": { "signature": "...", "url": "..." }
       }
     }
     ```

4. The Tauri updater fetches `latest.json` from the endpoint in
   `tauri.conf.json` and compares versions. UI in `UpdaterCard.tsx`
   surfaces "Check for updates" + "Install + relaunch".

## Endpoint URL

The default endpoint in `tauri.conf.json`:

```
https://github.com/agentcontrol/agentcontrol-tray/releases/latest/download/latest.json
```

Adjust the org / repo path if your fork differs. For private mirrors,
use any HTTPS URL that returns the same JSON shape.

## Update channels

Phase 27.4 settings expose a `stable` / `beta` channel toggle (not yet
wired to the updater). To enable per-channel releases, ship two
`latest.json` files (`latest-stable.json` + `latest-beta.json`) and
extend `tauri.conf.json.plugins.updater.endpoints` to use a `{channel}`
template var. The plugin supports endpoint placeholders out of the
box per the Tauri 2 updater docs.

## Why this isn't auto-bootstrapped

Keypair generation requires manual decision (where to store the
private key, what backup procedure, etc.) — those are operator-policy
choices that don't belong in the build. The placeholder in
`tauri.conf.json` makes the manual step impossible to forget: any
`pnpm tauri build` attempt will fail loud until a real pubkey lands.
