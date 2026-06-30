#!/usr/bin/env bash
# Build the AgentControl Windows bootstrapper.
#
# Needs only stock NSIS (no third-party plugins) -> runs on any Linux/macOS
# CI runner with `nsis` installed, or locally. Produces setup.exe.
#
#   apt-get install -y nsis   # or: brew install makensis
#   ./build.sh
set -euo pipefail

cd "$(dirname "$0")"
OUT="${1:-setup.exe}"

makensis -V2 agentcontrol-bootstrapper.nsi
mv -f agentcontrol-bootstrapper.exe "$OUT"

echo "built: $(pwd)/$OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"
