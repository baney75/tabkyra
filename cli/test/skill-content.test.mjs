// Regression checks on what bundled skills tell an agent to do. The lint checks a skill's
// safety and shape; these check that specific instructions stay correct after review found
// them wrong: commands are run where the tool exists, and wording is pinned where it isn't.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const skill = (name) => readFileSync(join(repo, "skills", name, "SKILL.md"), "utf8");
const root = mkdtempSync(join(tmpdir(), "tabkyra-skill-content-"));
after(() => rmSync(root, { recursive: true, force: true }));
const has = (cmd) => spawnSync(cmd, ["-version"], { encoding: "utf8" }).status === 0;
const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;

/** The one fenced block of a language in a skill, with the step's indent removed. */
function fenced(text, lang) {
	const m = text.match(new RegExp(`\\n( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n *\`\`\``));
	assert.ok(m, `a ${lang} block`);
	return m[2]
		.split("\n")
		.map((l) => l.slice(m[1].length))
		.join("\n");
}

test("notes: the rename helper leaves external URLs alone and takes titles literally", { skip: !hasPython && "no python3" }, () => {
	const helper = join(root, "note_rename.py");
	writeFileSync(helper, fenced(skill("notes"), "python"));
	const py = (...args) => spawnSync("python3", ["-I", helper, ...args], { encoding: "utf8" });

	const vault = join(root, "vault");
	mkdirSync(join(vault, "School"), { recursive: true });
	writeFileSync(join(vault, "School", "Bio.md"), "# Bio\n");
	const linker = join(vault, "Links.md");
	writeFileSync(
		linker,
		"[[Bio]] [[School/Bio|b]] ![[bio#Cells]] [local](School/Bio.md) [ext](https://example.org/Bio.md) [[MyBio]]\n",
	);
	assert.equal(py("check", vault, "School/Bio.md", "Biology 101").status, 0);
	renameSync(join(vault, "School", "Bio.md"), join(vault, "School", "Biology 101.md"));
	assert.equal(py("relink", vault, "School/Bio.md", "Biology 101").status, 0);
	assert.equal(py("verify", vault, "School/Bio.md", "Biology 101").status, 0);
	const text = readFileSync(linker, "utf8");
	assert.match(text, /\[ext\]\(https:\/\/example\.org\/Bio\.md\)/, "the external URL is untouched");
	assert.match(text, /\[local\]\(School\/Biology%20101\.md\)/);
	assert.match(text, /\[\[Biology 101\]\] \[\[School\/Biology 101\|b\]\] !\[\[Biology 101#Cells\]\]/);
	assert.match(text, /\[\[MyBio\]\]/);

	// A title with regex metacharacters: a leftover link fails verify instead of passing.
	writeFileSync(join(vault, "Q&A (2024).md"), "x\n");
	writeFileSync(join(vault, "Ref.md"), "see [[Q&A (2024)]] and [[C++ notes]]\n");
	assert.equal(py("verify", vault, "Q&A (2024).md", "QA 2024").status, 1);
	writeFileSync(join(vault, "C++ notes.md"), "x\n");
	assert.equal(py("verify", vault, "C++ notes.md", "Cpp notes").status, 1);
	writeFileSync(join(vault, "Alias.md"), "---\naliases: [Q&A (2024)]\n---\n");
	assert.equal(py("check", vault, "Q&A (2024).md", "QA 2024").status, 1, "an alias clash stops the rename");
});

test("video-editing: captions on a trimmed clip are shifted by the in point", () => {
	const text = skill("video-editing");
	const shift = text.match(/^ffmpeg -copyts -i cap\.srt .* cap-clip\.srt$/m);
	assert.ok(shift, "the worked example shifts the captions");
	assert.match(text, /-i clip\.mp4 -i cap-clip\.srt /, "the shifted file is the one muxed");
	assert.doesNotMatch(text, /-i clip\.mp4 -i cap\.srt /);
	assert.match(text, /-map 0:s:0 check\.srt/, "a soft track is checked by extracting it");
	if (!has("ffmpeg")) return;
	const dir = mkdtempSync(join(root, "srt-"));
	const cue = (n, a, b) => `${n}\n00:00:${a},000 --> 00:00:${b},000\nline ${n}\n`;
	writeFileSync(join(dir, "cap.srt"), [cue(1, "05", "07"), cue(2, "13", "15"), cue(3, "46", "50"), cue(4, "55", "57")].join("\n"));
	const r = spawnSync("bash", ["-c", `ffmpeg -v error -y ${shift[0].slice("ffmpeg ".length)}`], { cwd: dir, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	const times = [...readFileSync(join(dir, "cap-clip.srt"), "utf8").matchAll(/^(\S+) -->/gm)].map((m) => m[1]);
	assert.deepEqual(times, ["00:00:01,000", "00:00:34,000"], "13 s and 46 s in the source land at 1 s and 34 s");
});

test("video-editing: clips that differ are normalized to one size, rate and audio format before a join", () => {
	const text = skill("video-editing");
	const norm = text.match(/`(ffmpeg -i a\.mp4 -vf "scale=[^`]+ n-a\.mp4)`/);
	assert.ok(norm, "step 5 has a normalize command");
	for (const opt of ["fps=", "pad=", "setsar=1", "-ar ", "-ac ", "-pix_fmt yuv420p"]) assert.ok(norm[1].includes(opt), opt);
	if (!has("ffmpeg")) return;
	const dir = mkdtempSync(join(root, "join-"));
	const make = (name, size, rate, ar, ac) =>
		spawnSync(
			"ffmpeg",
			["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}:duration=2`, "-f", "lavfi", "-i", `sine=d=2:sample_rate=${ar}`]
				.concat(["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-ac", ac, "-shortest", name]),
			{ cwd: dir },
		).status;
	assert.equal(make("a.mp4", "1280x720", 24, 44100, "1"), 0);
	assert.equal(make("b.mp4", "1920x1080", 30, 48000, "2"), 0);
	for (const c of ["a", "b"]) {
		const cmd = norm[1].replaceAll("a.mp4", `${c}.mp4`).replace("-crf 18", "-crf 18 -preset ultrafast");
		const r = spawnSync("bash", ["-c", cmd.replace(/^ffmpeg /, "ffmpeg -v error -y ")], { cwd: dir, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	}
	writeFileSync(join(dir, "list.txt"), "file 'n-a.mp4'\nfile 'n-b.mp4'\n");
	assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], { cwd: dir }).status, 0);
	const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "joined.mp4"], { cwd: dir, encoding: "utf8" });
	assert.ok(Math.abs(Number(probe.stdout) - 4) < 0.1, `joined length ${probe.stdout}`);
});

test("email-organization: read-back checks the row's own mail, and every count in the example was searched", () => {
	const text = skill("email-organization");
	const step8 = text.slice(text.indexOf("8. **Read back"), text.indexOf("9. **Report"));
	assert.match(step8, /query plus `-label:/, "label membership is checked on the row's query");
	assert.doesNotMatch(step8, /search `label:Receipts`; with Existing mail yes the count must match/);
	assert.match(step8, /with no,[^.]*count before applying[^.]*must not change/, "a future-only archive row keeps existing inbox mail");
	const example = text.slice(text.indexOf("## Worked example"));
	const counts = [...example.matchAll(/"1-50 of ([\d,]+)"/g)].map((m) => m[1]);
	for (const n of ["214", "402", "1,380"]) assert.ok(counts.includes(n), `a count header for ${n}`);
	const shops = example.match(/#search\/from%3A\(([^)]*receipts[^)]*)\)/);
	assert.equal(shops[1].split("+OR+").length, 3, "the 3-shop row's query names 3 senders");
	assert.match(example, /3 shops/);
});

test("chemistry: a mixing question reads SDS section 10, not only GHS codes", () => {
	const text = skill("chemistry");
	assert.match(text, /\*\*Mixing or storing two chemicals together\*\*[\s\S]*?section\s+10 \(stability and reactivity/);
	assert.match(text, /^- A mixing answer names the reaction product and quotes section 10 of both SDSs\.$/m);
	assert.match(text, /^- Mixing hazards come from SDS section 10, not from GHS codes\.$/m);
});

test("office-docs: the Downloads snapshot goes to a private mktemp file, never a fixed /tmp path", () => {
	const text = skill("office-docs");
	assert.doesNotMatch(text, /\/tmp\//);
	assert.match(text, /snap=\$\(mktemp\)/);
	assert.match(text, /rm -f "\[snap\]"/);
});

test("proton: a username in a Pass result row is list text, not a sign of an open item", () => {
	const text = skill("proton");
	assert.doesNotMatch(text, /shows a username, password or code, an item is open/);
	assert.match(text, /Each result row shows a username or email under its title/);
	assert.match(text, /an item's detail pane means an item is open/);
});

test("skill-platform doc states the evidence rule at min(catalog size, 13) skills", () => {
	const doc = readFileSync(join(repo, "docs", "skill-platform.md"), "utf8");
	assert.match(doc, /min\(catalog size, 13\)/);
});
