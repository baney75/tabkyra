import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
const outDir = join(packageRoot, "dist-chrome");

const entryPoints = {
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	background: join(packageRoot, "src/background.ts"),
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ============================================================================
// REMOVED SIGN-INS (docs/auth-policy.md)
// ============================================================================
// pi-ai ships providers for ChatGPT, Gemini CLI and Copilot subscriptions that pose as
// Codex CLI, Gemini CLI and VS Code. Tabkyra never offers them, so their code and the
// models that carry their headers are left out of the bundle, not just hidden.
const REMOVED_PROVIDERS = ["github-copilot", "google-antigravity", "google-gemini-cli", "openai-codex"];
const refuse = (name) =>
	`export const ${name} = () => { throw new Error("Subscription sign-in was removed from Tabkyra; see docs/auth-policy.md"); };`;
const piAiStubs = {
	"providers/openai-codex-responses.ts": [
		refuse("streamOpenAICodexResponses"),
		refuse("streamSimpleOpenAICodexResponses"),
	].join("\n"),
	"providers/google-gemini-cli.ts": [refuse("streamGoogleGeminiCli"), refuse("streamSimpleGoogleGeminiCli")].join(
		"\n",
	),
	"providers/github-copilot-headers.ts": [
		"export const inferCopilotInitiator = () => 'user';",
		"export const hasCopilotVisionInput = () => false;",
		"export const buildCopilotDynamicHeaders = () => ({});",
	].join("\n"),
};

/** Drop the removed providers' top-level blocks from models.generated.ts. */
function stripRemovedModels(source) {
	const lines = source.split("\n");
	const out = [];
	let skipping = false;
	for (const line of lines) {
		if (!skipping && REMOVED_PROVIDERS.some((p) => line === `\t"${p}": {`)) {
			skipping = true;
			continue;
		}
		if (skipping) {
			if (line === "\t},") skipping = false;
			continue;
		}
		out.push(line);
	}
	if (skipping) throw new Error("models.generated.ts: a removed provider block never closed");
	return out.join("\n");
}

/**
 * pi-ai's Anthropic provider treats an sk-ant-oat token as a Claude subscription and
 * sends Claude Code's identity headers with it. Tabkyra refuses those tokens earlier
 * (src/auth/policy.ts); here the branch itself goes, so no build can pose as Claude Code.
 */
function stripClaudeCodeIdentity(source) {
	const edits = [
		[
			/function isOAuthToken\(apiKey: string\): boolean \{[^}]*\}/,
			"function isOAuthToken(_apiKey: string): boolean {\n\treturn false;\n}",
		],
		[/\s*"user-agent": `claude-cli\/\$\{claudeCodeVersion\}`,/, ""],
		[/\s*"x-app": "cli",/, ""],
		[/claude-code-\d{8},oauth-\d{4}-\d\d-\d\d,/, ""],
	];
	let out = source;
	for (const [pattern, replacement] of edits) {
		if (!pattern.test(out))
			throw new Error(`anthropic.ts changed upstream: ${pattern} not found; re-check docs/auth-policy.md`);
		out = out.replace(pattern, replacement);
	}
	return out;
}

const stripRemovedSignIns = {
	name: "strip-removed-sign-ins",
	setup(b) {
		const aiSrc = join(packageRoot, "../pi-mono/packages/ai/src/");
		b.onLoad({ filter: /pi-mono[\\/]packages[\\/]ai[\\/]src[\\/].*\.ts$/ }, (args) => {
			const rel = args.path.slice(aiSrc.length).replaceAll("\\", "/");
			if (piAiStubs[rel]) return { contents: piAiStubs[rel], loader: "ts" };
			if (rel === "models.generated.ts")
				return { contents: stripRemovedModels(readFileSync(args.path, "utf8")), loader: "ts" };
			if (rel === "providers/anthropic.ts")
				return { contents: stripClaudeCodeIdentity(readFileSync(args.path, "utf8")), loader: "ts" };
			return undefined;
		});
	},
};

const buildOptions = {
	plugins: [stripRemovedSignIns],
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		global: "globalThis",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	// Let bare imports inside the bundled pi-mono source resolve against pi-mono's
	// installed dependencies (openai, @anthropic-ai/sdk, typebox, ...).
	nodePaths: [join(packageRoot, "../pi-mono/node_modules")],
	// Force all mini-lit and lit imports to resolve to tabkyra's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		// Bundle the sibling pi-mono packages straight from TypeScript source. Their
		// published entrypoints are dist/ builds that require the tsgo toolchain; pointing
		// esbuild at src/ lets us build without pre-compiling them.
		"@mariozechner/pi-ai": join(packageRoot, "../pi-mono/packages/ai/src/index.ts"),
		"@mariozechner/pi-agent-core": join(packageRoot, "../pi-mono/packages/agent/src/index.ts"),
		"@mariozechner/pi-web-ui": join(packageRoot, "../pi-mono/packages/web-ui/src/index.ts"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// ============================================================================
// VERSIONING
// ============================================================================
// Every production build bumps the version. Each component runs 1..10; when one
// would exceed 10 it rolls over to 1 and the next-higher component increments:
//   1.1.1 -> 1.1.2 -> ... -> 1.1.10 -> 1.2.1 -> ... -> 1.10.10 -> 2.1.1 -> ...
// Major caps at 10 (stays at 10.10.10). Watch/dev rebuilds do NOT bump.
const computeNextVersion = (version) => {
	const parts = String(version)
		.split(".")
		.map((p) => Number.parseInt(p, 10));
	let [major, minor, patch] = parts;
	// If the current version is outside the 1..10 scheme, snap to the baseline.
	const inScheme = [major, minor, patch].every((n) => Number.isInteger(n) && n >= 1 && n <= 10);
	if (!inScheme) return "1.1.1";
	patch += 1;
	if (patch > 10) {
		patch = 1;
		minor += 1;
	}
	if (minor > 10) {
		minor = 1;
		major += 1;
	}
	if (major > 10) {
		return "10.10.10"; // cap
	}
	return `${major}.${minor}.${patch}`;
};

const bumpVersion = () => {
	const manifestPath = join(packageRoot, "static/manifest.chrome.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const current = manifest.version || "1.0.0";
	const next = computeNextVersion(current);
	if (next === current) {
		console.log(`Version: ${current} (capped)`);
		return next;
	}
	manifest.version = next;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	// Keep package.json in sync so the repo version matches the shipped manifest.
	try {
		const pkgPath = join(packageRoot, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		pkg.version = next;
		writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);
	} catch {
		// non-fatal
	}

	console.log(`Version: ${current} -> ${next}`);
	return next;
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		// `tabkyra setup` builds with TABKYRA_NO_BUMP=1 so installing never edits the checkout.
		if (!process.env.TABKYRA_NO_BUMP) bumpVersion();
		await build(buildOptions);
		copyStatic();
		// The stylesheet is generated by Tailwind; without it the side panel renders unstyled.
		// `npm run build` also runs this step, but a direct invocation must produce a complete bundle.
		execSync("npx tailwindcss -i ./src/app.css -o ./dist-chrome/app.css --minify", {
			cwd: packageRoot,
			stdio: "inherit",
		});
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
