// Spike: one process hosts two tutors in different directories at the same time.
// Each must call its own in-process tool on the first turn and answer a second
// user turn. Needs ANTHROPIC_API_KEY. Run: node spike/two-tutors.ts <dirA> <dirB>

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeDriver } from "../src/daemon/claude-driver.ts";
import { defineTool } from "../src/daemon/driver.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
const dirs = process.argv.slice(2);
if (!apiKey || dirs.length !== 2) {
	console.error(
		"usage: ANTHROPIC_API_KEY=... node spike/two-tutors.ts <dirA> <dirB>",
	);
	process.exit(2);
}

const driver = new ClaudeDriver({ apiKey });
const started = Date.now();
const log = (label: string, text: string) =>
	console.log(
		`[${((Date.now() - started) / 1000).toFixed(1)}s ${label}] ${text}`,
	);

async function runTutor(label: string, cwd: string): Promise<boolean> {
	const shown: string[] = [];
	const session = await driver.open({
		cwd,
		scratchDir: mkdtempSync(join(tmpdir(), "pedagogy-spike-")),
		systemPrompt:
			"You are a tutor. Show the learner files with the show_file tool. Keep replies to one sentence.",
		tools: [
			defineTool({
				name: "show_file",
				description: "Show a file from the working directory to the learner.",
				input: { path: z.string() },
				async handler({ path }) {
					shown.push(path);
					log(label, `tool show_file ${path}`);
					return "shown";
				},
			}),
		],
	});

	session.send("List this directory and show me one file from it.");
	let turns = 0;
	for await (const event of session.events) {
		if (event.type === "text") log(label, `text ${event.text.slice(0, 100)}`);
		if (event.type === "turn_end") {
			turns += 1;
			log(label, `turn ${turns} ended${event.error ? `: ${event.error}` : ""}`);
			if (turns === 1) session.send("Which file did you just show me?");
			else session.close();
		}
		if (event.type === "closed" && event.error)
			log(label, `closed: ${event.error}`);
	}
	const ok = turns === 2 && shown.length > 0;
	log(label, ok ? "PASS" : `FAIL turns=${turns} shown=${shown.length}`);
	return ok;
}

const results = await Promise.all([
	runTutor("A", dirs[0] as string),
	runTutor("B", dirs[1] as string),
]);
process.exit(results.every(Boolean) ? 0 : 1);
