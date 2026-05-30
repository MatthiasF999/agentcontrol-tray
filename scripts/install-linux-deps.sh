#!/usr/bin/env bash
# Phase 27.0 operator-action — Linux Tauri system-deps install.
#
# Tauri's webkit-based webview requires GTK + WebKitGTK + supporting
# libs that the rustup toolchain CANNOT install in user-space. Runs
# `apt install` with sudo, then verifies via pkg-config.
#
# Usage: bash scripts/install-linux-deps.sh
#
# This script is idempotent — running it twice is safe.

set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Do not run this script as root. It calls sudo internally where needed." >&2
  exit 2
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets apt-based distros (Ubuntu, Debian)." >&2
  echo "For Fedora/Arch see docs/PHASE-27-0-SPIKE.md." >&2
  exit 3
fi

echo "==> Installing Tauri Linux build-deps via apt..."
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libdbus-1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  build-essential \
  curl wget file pkg-config

echo
echo "==> Verifying via pkg-config..."
for pkg in webkit2gtk-4.1 dbus-1 ayatana-appindicator3-0.1 librsvg-2.0; do
  if pkg-config --modversion "$pkg" >/dev/null 2>&1; then
    echo "  OK $pkg $(pkg-config --modversion "$pkg")"
  else
    echo "  MISSING $pkg — install may have failed" >&2
    exit 4
  fi
done

echo
echo "==> All Tauri Linux deps present."
echo "    Next: cd src-tauri && cargo check"
