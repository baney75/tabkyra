#!/usr/bin/env node
// Release notes for a version from CHANGELOG.md: node scripts/release/notes.mjs 1.2.0 > notes.md
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const core = version.replace(/-.*/, "");
const log = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md"), "utf8");
const heading = new RegExp(`## \\[${core.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
const notes = log.match(heading)?.[1].trim() ?? "";
process.stdout.write(
	`${notes}\n\n---\n\nUpdate with \`tabkyra update\` (it verifies the minisign signature and the checksum), then reload Tabkyra.\n`,
);
