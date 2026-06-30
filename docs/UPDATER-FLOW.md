# Updater flow — signature verification, key rotation, E2E test plan

How the Tauri auto-updater verifies an update, how to rotate the signing
key without bricking existing installs, and how to test an in-place
update end-to-end. Companion to `PHASE-27-7-AUTOUPDATE.md` (which covers
one-time operator key setup + per-release publishing).

## How verification works

The updater plugin (`@tauri-apps/plugin-updater` + the Rust
`tauri-plugin-updater`) is configured in
`src-tauri/tauri.conf.json → plugins.updater`:

- `endpoints` — where the manifest lives. Ours points at the GitHub
  `releases/latest/download/latest.json` redirect, so the newest
  published release always wins.
- `pubkey` — the base64-wrapped **minisign public key**. Embedded in the
  binary at build time; cannot be changed without shipping a new build.

On "Check for updates" the plugin:

1. **Fetches `latest.json`** and compares `version` to the running app.
2. If newer, downloads the binary at `platforms[<target>].url`.
3. **Verifies the signature** in `platforms[<target>].signature` against
   the embedded `pubkey`. Only if this passes is the update applied.

### The `signature` field is a minisign `.sig`, not a hash

A common misread: the `signature` field is *not* a SHA256 of the binary.
It is the **base64-encoded contents of the `.sig` file** that
`tauri signer sign` produces — a full minisign signature. Tauri double
base64-encodes both the pubkey (in `tauri.conf.json`) and the `.sig`
contents (in `latest.json`); decode once to recover standard minisign
text.

Tauri signs in minisign **prehashed mode** (algorithm tag `ED`): the
Ed25519 signature covers `BLAKE2b-512(binary)`, not the raw bytes. The
signature file also carries a *trusted comment* (`timestamp:… file:…`)
protected by a second Ed25519 "global" signature over
`raw_sig_bytes || trusted_comment`. A valid update therefore proves:

- the binary's BLAKE2b-512 digest was signed by the private key whose
  public half is embedded, **and**
- the filename + timestamp in the trusted comment weren't swapped.

Integrity (no SHA256 needed): forging a binary with the same BLAKE2b-512
digest *and* a valid Ed25519 signature is infeasible, so the minisign
check subsumes a content hash. `scripts/validate-updater.mjs` reproduces
exactly these two checks in pure Node (no `minisign` binary required).

### Running the validator

```bash
node scripts/validate-updater.mjs          # validates v<conf.version>
node scripts/validate-updater.mjs v0.5.0   # validates an explicit tag
```

It reads the pubkey straight from `src-tauri/tauri.conf.json`, fetches
the release `latest.json`, downloads each platform binary, and prints
`PASS`/`FAIL` per platform (exit non-zero on any failure). It also warns
when no `darwin-*` platform is present.

## Rotating the signing key without breaking existing users

The pubkey is **baked into each installed binary**. An installed app
will only accept an update signed by the key it shipped with. So you
cannot simply swap keys — older installs would reject everything signed
by the new key and be stuck forever on their current version.

Safe rotation is a two-release bridge:

1. **Release N (transition build).** Keep signing with the **old** key
   (so every already-installed app accepts this update), but in this
   build's `tauri.conf.json` embed the **new** pubkey. After users
   update to N, their installed app now trusts the new key.
2. **Release N+1 onward.** Sign with the **new** key. Installs that took
   release N accept it.
3. **Laggards** (anyone who never installed N) are stranded — their app
   still trusts only the old key. Options: keep signing a parallel
   old-key `latest.json` channel until adoption is high enough, or
   accept that they must reinstall manually from the website.

Practical guidance:

- Treat key rotation as rare (compromise / algorithm change). Store the
  private key (`~/.tauri/agentcontrol-tray.key`) + its password in a
  secret manager; back it up. Losing it forces the reinstall path for
  everyone.
- In CI the key lives in `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets — rotate those in
  lockstep with the two-release bridge above.
- Never publish a release whose embedded pubkey and signing key
  disagree for the *current* platform without doing it as the
  deliberate transition build (step 1).

## Manual end-to-end test plan (in-place update)

Goal: prove a running install actually upgrades itself, not just that
signatures validate.

Prep — a "newer" build to update *to*:

1. Bump `version` in `src-tauri/tauri.conf.json` (e.g. `0.5.0` →
   `0.5.1`) on a throwaway branch.
2. `pnpm tauri build` with the real `TAURI_SIGNING_PRIVATE_KEY` set so
   `createUpdaterArtifacts` emits signed bundles + `.sig` files.
3. Mock-publish: either push a real `v0.5.1` tag (the
   `build-release.yml` workflow builds + uploads + writes `latest.json`),
   or serve a hand-built `latest.json` + bundles from a local static
   server and point `endpoints` at it for the test.

Test:

4. Install the **older** release first: download `v0.5.0` from GitHub and
   install it (`.deb`/AppImage on Linux, NSIS on Windows). Launch it.
5. In the app's updater UI (`UpdaterCard.tsx`): **Check for updates** →
   it should detect `0.5.1`.
6. **Install + relaunch**. The app downloads `0.5.1`, verifies the
   signature against the embedded pubkey, applies it, and relaunches.
7. Confirm the running version is now `0.5.1` (About tab / version
   string).

Negative checks (signature really gates the update):

8. Corrupt one byte of the published binary (leave the `.sig`
   untouched) and retry the update — it must **refuse** to apply.
   `scripts/validate-updater.mjs` automates the digest+signature half of
   this; its negative path was confirmed (a single flipped byte fails
   verification).
9. Sign `0.5.1` with a *different* key than the installed app's embedded
   pubkey — the update must be rejected (this is exactly the laggard
   case from key rotation).

Per-platform notes:

- **Linux**: AppImage self-replaces; `.deb` installs need the app to
  have write access to its install location (test both `linux-x86_64`
  AppImage and `linux-x86_64-deb`).
- **Windows**: NSIS installer relaunches via the elevated updater;
  verify no SmartScreen block interrupts the silent reinstall.
- **macOS**: **currently untestable** — `latest.json` ships no
  `darwin-*` entry (see below), so Mac installs never see an update.

## Known gap — macOS not covered

As of `v0.5.0` the release uploads `agentcontrol-tray_0.5.0_aarch64.dmg`
but `latest.json` contains **no `darwin-*` platform** and no `.dmg.sig`
was published. macOS users therefore receive no in-place updates. To
close this, the release workflow must build the macOS updater artifact
(an `.app.tar.gz` + `.sig`, not the `.dmg`) and add `darwin-aarch64` /
`darwin-x86_64` keys to the manifest. The validator emits a warning
until this is fixed.
