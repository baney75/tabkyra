import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: root,
	// router-worker: the router alone, for `skill eval --router` (CI's judge runs a pull
	// request's router this way, in a process of its own).
	entryPoints: { index: join(root, "src/index.ts"), "router-worker": join(root, "src/router-worker.ts") },
	bundle: true,
	platform: "node",
	target: ["node20"],
	format: "esm",
	outdir: outDir,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle everything (incl. the MCP SDK and zod) so the CLI is self-contained and runs
	// from a global link or npx without a node_modules next to dist.
	packages: "bundle",
	sourcemap: true,
	// keys/tabkyra-release.pub is bundled as text: the key that verifies releases ships inside the CLI.
	loader: { ".pub": "text", ".md": "text" },
	logLevel: "info",
});
chmodSync(join(outDir, "index.js"), 0o755);
