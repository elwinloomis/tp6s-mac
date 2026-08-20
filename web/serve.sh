#!/usr/bin/env bash
# Serve the TP6-S web tool over HTTP.
#
# You do not need this. The tool is a static page with no build step and no
# fetches, so opening tp6s.html straight from the filesystem works, and a
# file:// URL is a secure context in Chrome, which is what Web Bluetooth and
# the local font picker actually require.
#
# It is here for the two cases where file:// is not what you want: putting the
# tool on a machine you reach over the network, and testing it the way it would
# behave if hosted.

set -euo pipefail

PORT="${1:-8778}"
cd "$(dirname "$0")"

echo "TP6-S -> http://127.0.0.1:${PORT}/tp6s.html"
echo "Ctrl-C to stop."

(
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/tp6s.html" 2>/dev/null; then
      command -v open >/dev/null && open "http://127.0.0.1:${PORT}/tp6s.html"
      break
    fi
    sleep 0.25
  done
) &

exec python3 -m http.server "$PORT" --bind 127.0.0.1
