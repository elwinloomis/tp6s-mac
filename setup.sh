#!/bin/bash
# Ensure the TP6-S toolkit is ready to run on THIS machine.
# The venv lives outside the repository (~/.venvs/tp6s) because venvs are
# machine-specific and do not survive movement or syncing reliably.
# Run it any time; it's safe to re-run. Pass --pdf for Quartz or --research
# for Quartz plus the macOS Bluetooth Classic framework.

set -euo pipefail

VENV="$HOME/.venvs/tp6s"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WITH_PDF=0
WITH_RESEARCH=0

case "${1:-}" in
    "") ;;
    --pdf) WITH_PDF=1 ;;
    --research) WITH_PDF=1; WITH_RESEARCH=1 ;;
    --help|-h)
        echo "Usage: ./setup.sh [--pdf | --research]"
        echo "  --pdf  also install the optional macOS PDF Service dependency"
        echo "  --research  also install macOS frameworks used by research tools"
        exit 0
        ;;
    *)
        echo "ERROR: unknown option: $1" >&2
        echo "Usage: ./setup.sh [--pdf | --research]" >&2
        exit 2
        ;;
esac

echo "== TP6-S setup check on $(hostname -s) =="

if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: python3 not found. Install it (e.g. 'brew install python' or from python.org)." >&2
    exit 1
fi

echo "python3: $(python3 --version) ($(command -v python3))"

# Rebuild the venv if it's missing or broken (e.g. python was upgraded)
if ! "$VENV/bin/python" -c "import sys" >/dev/null 2>&1; then
    echo "Creating venv at $VENV ..."
    rm -rf "$VENV"
    mkdir -p "$(dirname "$VENV")"
    python3 -m venv "$VENV"
fi

echo "Checking pinned runtime dependencies (bleak, Pillow) ..."
"$VENV/bin/pip" install --quiet --requirement "$SCRIPT_DIR/requirements.txt"

"$VENV/bin/python" - <<'EOF'
from importlib.metadata import version
import bleak, PIL
print(f"deps ok: bleak {version('bleak')} | pillow {version('pillow')}")
EOF

# Quartz rasterizes the PDF that the print dialog hands to the "Send to TP6-S"
# service (tools/pdf_service.py). macOS only, and only that one feature needs
# it, so a machine without it keeps every other command working.
if [ "$WITH_PDF" = "1" ]; then
    if [ "$(uname -s)" != "Darwin" ]; then
        echo "ERROR: --pdf is available only on macOS." >&2
        exit 1
    fi
    echo "Checking the PDF-service dependency (pyobjc Quartz) ..."
    "$VENV/bin/pip" install --quiet --requirement "$SCRIPT_DIR/requirements-pdf.txt"
    "$VENV/bin/python" - <<'EOF'
from importlib.metadata import version
import Quartz
print(f"deps ok: pyobjc-framework-Quartz {version('pyobjc-framework-Quartz')}")
EOF
fi

if [ "$WITH_RESEARCH" = "1" ]; then
    echo "Checking the research-only IOBluetooth dependency ..."
    "$VENV/bin/pip" install --quiet --requirement "$SCRIPT_DIR/requirements-research.txt"
    "$VENV/bin/python" - <<'EOF'
from importlib.metadata import version
import IOBluetooth
print(f"deps ok: pyobjc-framework-IOBluetooth {version('pyobjc-framework-IOBluetooth')}")
EOF
fi

# Clean up an old venv accidentally created inside the repository
if [ -d "$SCRIPT_DIR/.venv" ]; then
    echo "Removing stale in-repository venv ($SCRIPT_DIR/.venv) ..."
    rm -rf "$SCRIPT_DIR/.venv"
fi

echo ""
echo "Ready. Run the tool with:"
echo "  ./tp6 gui"
echo "  ./tp6 print \"Hello\""
echo "  ./tp6 image photo.jpg"
if [ "$WITH_PDF" = "0" ]; then
    echo "  ./setup.sh --pdf  # optional: prepare the macOS PDF Service"
fi
