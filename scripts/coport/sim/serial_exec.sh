#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
exec python3 -B scripts/coport/sim/serial_exec.py "$@"
