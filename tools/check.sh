#!/bin/bash
# Off-hardware checks used locally and by GitHub Actions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash -n setup.sh tp6 tools/install_pdf_service.sh web/serve.sh tools/check.sh

python3 -c 'import ast, pathlib
files = list(pathlib.Path(".").glob("*.py")) + list(pathlib.Path("tools").glob("*.py")) + list(pathlib.Path("research").glob("*.py"))
for path in files:
    ast.parse(path.read_text(), filename=str(path))
print(f"Python syntax: {len(files)} files OK")'

for file in web/src/*.js tools/*.js; do
    node --check "$file"
done

node tools/ble_sim_test.js
git diff --check

echo "Shell syntax: OK"
echo "JavaScript syntax: OK"
echo "Whitespace check: OK"
