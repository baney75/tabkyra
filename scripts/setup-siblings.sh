#!/bin/bash
# Check out the sibling repos this extension builds against, apply the pi-mono patch,
# and build the pi-mono declarations that type checking needs.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
parent="$(dirname "$here")"
pi_mono_rev="ff1ea1232"

[ -d "$parent/mini-lit" ] || git clone https://github.com/badlogic/mini-lit.git "$parent/mini-lit"
[ -d "$parent/pi-mono" ] || git clone https://github.com/badlogic/pi-mono.git "$parent/pi-mono"

cd "$parent/pi-mono"
if ! git diff --quiet; then
	if git apply --reverse --check "$here/patches/pi-mono.patch" 2>/dev/null; then
		echo "pi-mono patch already applied"
	else
		echo "pi-mono has local changes that are not patches/pi-mono.patch; resolve them first" >&2
		exit 1
	fi
else
	git checkout -q "$pi_mono_rev"
	git apply "$here/patches/pi-mono.patch"
fi

(cd "$parent/mini-lit" && npm install --no-audit --no-fund && npm run build)
npm install --no-audit --no-fund
# Never run `npm run build` in packages/ai: it regenerates the model list.
for pkg in tui ai agent web-ui; do
	(cd "packages/$pkg" && npx tsgo -p tsconfig.build.json)
done

cd "$here"
npm install --no-audit --no-fund
(cd cli && npm install --no-audit --no-fund)
