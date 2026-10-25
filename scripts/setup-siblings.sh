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
		# An older revision of the patch is applied: swap it for the current one, but only
		# when the local changes are exactly that older patch, so no hand edits are lost.
		current="$(git diff)"
		upgraded=""
		for rev in $(git -C "$here" log --format=%H -- patches/pi-mono.patch); do
			old_patch="$(git -C "$here" show "$rev:patches/pi-mono.patch" 2>/dev/null || true)"
			if [ -n "$old_patch" ] && [ "$old_patch" = "$current" ]; then
				echo "pi-mono has an older patch (${rev:0:7}); updating it"
				git -C "$here" show "$rev:patches/pi-mono.patch" | git apply --reverse
				git apply "$here/patches/pi-mono.patch"
				upgraded=1
				break
			fi
		done
		if [ -z "$upgraded" ]; then
			echo "pi-mono has local changes that are not patches/pi-mono.patch; resolve them first" >&2
			exit 1
		fi
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
