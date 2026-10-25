import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
// The extension version this CLI ships with; `tabkyra doctor` compares the build against it.
const extensionVersion = JSON.parse(readFileSync(join(root, "..", "static", "manifest.chrome.json"), "utf8")).version;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: root,
	entryPoints: { index: join(root, "src/index.ts") },
	bundle: true,
	platform: "node",
	target: ["node20"],
	format: "esm",
	outdir: outDir,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle everything (incl. the MCP SDK and zod) so the CLI is self-contained and runs
	// from a global link or npx without a node_modules next to dist.
	packages: "bundle",
	define: { __EXTENSION_VERSION__: JSON.stringify(extensionVersion) },
	sourcemap: true,
	logLevel: "info",
});
chmodSync(join(outDir, "index.js"), 0o755);
