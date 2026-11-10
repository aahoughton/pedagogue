import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	type AgentDriver,
	type AgentSession,
	defineTool,
	type ToolSpec,
} from "./driver.ts";
import {
	excerpt,
	formatRanges,
	type LineRange,
	lineCount,
	toRanges,
} from "./lines.ts";
import { TUTOR_PROMPT } from "./tutor-prompt.ts";

export type Pane =
	| {
			id: string;
			kind: "code";
			title: string;
			/** Relative to the tour's directory. */
			path: string;
			text: string;
			highlights: LineRange[];
			note?: string;
	  }
	| { id: string; kind: "markdown"; title: string; markdown: string }
	| { id: string; kind: "diagram"; title: string; mermaid: string }
	| { id: string; kind: "html"; title: string; html: string };

export interface Selection {
	paneId: string;
	/** 1-based line numbers, in any order. A dragged range and a picked set both arrive this way. */
	lines: number[];
}

export type TranscriptItem =
	| {
			id: string;
			kind: "tutor";
			text: string;
			/** True while the tutor is still writing this message. */
			streaming?: boolean;
	  }
	| {
			id: string;
			kind: "learner";
			text: string;
			selection?: { path: string; ranges: LineRange[] };
	  }
	| {
			id: string;
			kind: "quiz";
			question: string;
			choices: string[];
			answer?: string;
			/** True when the learner moved on without answering. */
			skipped?: boolean;
	  };

type TutorItem = Extract<TranscriptItem, { kind: "tutor" }>;
type QuizItem = Extract<TranscriptItem, { kind: "quiz" }>;

export type TourStatus = "working" | "waiting" | "closed";

export interface TourState {
	id: string;
	cwd: string;
	title: string;
	status: TourStatus;
	/** Set when the tour closed because of a failure. */
	error?: string;
	outline: string[];
	/** Index into `outline` of the step in progress. */
	step?: number;
	/** What the tutor is doing right now, while status is "working". */
	activity?: string;
	panes: Pane[];
	focus?: string;
	transcript: TranscriptItem[];
}

/** An incremental change to a TourState, applied in order by every viewer. */
export type TourEvent =
	| { type: "snapshot"; state: TourState }
	| { type: "pane"; pane: Pane }
	| { type: "pane_closed"; id: string }
	| { type: "focus"; id: string }
	| { type: "outline"; outline: string[]; step?: number }
	| { type: "item"; item: TranscriptItem }
	/** Text to add to the end of a tutor item that is still being written. */
	| { type: "item_delta"; id: string; text: string }
	| { type: "activity"; label?: string }
	| { type: "status"; status: TourStatus; error?: string };

export type LearnerInput =
	| { type: "message"; text: string; selection?: Selection }
	| { type: "answer"; quizId: string; text: string }
	/** A viewer could not render a pane, for example a diagram with a syntax error. */
	| { type: "pane_error"; paneId: string; message: string }
	| { type: "interrupt" };

export class InputError extends Error {}

export interface TourOptions {
	id: string;
	cwd: string;
	scratchDir: string;
	brief: string;
	driver: AgentDriver;
}

/**
 * One tutoring session: the display state, the tutor agent that drives it, and the
 * learner input that feeds the agent. Viewers subscribe for events and can rebuild
 * the full state from a snapshot followed by the events after it.
 */
export class Tour {
	readonly #state: TourState;
	#session!: AgentSession;
	readonly #subscribers = new Set<(event: TourEvent) => void>();
	#nextId = 1;
	/** Panes whose render failure the tutor has already been told about. */
	readonly #reportedPaneErrors = new Set<string>();
	/** Transcript items being streamed, by the driver's text id. */
	readonly #streaming = new Map<string, TutorItem>();

	/** Starts the tutor and hands it the brief. Rejects if the tutor cannot start. */
	static async open(options: TourOptions): Promise<Tour> {
		const tour = new Tour(options);
		tour.#session = await options.driver.open({
			cwd: options.cwd,
			scratchDir: options.scratchDir,
			systemPrompt: TUTOR_PROMPT,
			tools: tour.#tools(),
		});
		tour.#session.send(options.brief);
		void tour.#consume();
		return tour;
	}

	private constructor(options: TourOptions) {
		this.#state = {
			id: options.id,
			cwd: options.cwd,
			title: firstLine(options.brief),
			status: "working",
			outline: [],
			panes: [],
			transcript: [],
		};
	}

	get id(): string {
		return this.#state.id;
	}

	get state(): TourState {
		return structuredClone(this.#state);
	}

	/** Calls `listener` with a snapshot, then with every later event. Returns an unsubscribe function. */
	subscribe(listener: (event: TourEvent) => void): () => void {
		listener({ type: "snapshot", state: this.state });
		this.#subscribers.add(listener);
		return () => this.#subscribers.delete(listener);
	}

	/** Throws InputError when the input does not fit the tour's current state. */
	input(input: LearnerInput): void {
		if (this.#state.status === "closed") {
			throw new InputError("this tour has ended");
		}
		if (input.type === "interrupt") {
			void this.#session.interrupt();
			return;
		}
		if (input.type === "pane_error") {
			// Every viewer of a broken pane reports it; the tutor hears it once.
			const known = this.#state.panes.some((p) => p.id === input.paneId);
			if (!known || this.#reportedPaneErrors.has(input.paneId)) return;
			this.#reportedPaneErrors.add(input.paneId);
			this.#toAgent(
				`<pane_error pane=${JSON.stringify(input.paneId)}>\n${input.message}\n</pane_error>\nThe learner cannot see this pane. Fix it and show it again.`,
			);
			return;
		}
		if (input.type === "answer") {
			const quiz = this.#state.transcript.find(
				(item) => item.kind === "quiz" && item.id === input.quizId,
			);
			if (quiz?.kind !== "quiz") {
				throw new InputError(`no such quiz: ${input.quizId}`);
			}
			if (quiz.answer !== undefined) {
				throw new InputError("that quiz is already answered");
			}
			if (quiz.skipped) {
				throw new InputError("that quiz was skipped");
			}
			quiz.answer = input.text;
			this.#emit({ type: "item", item: quiz });
			this.#toAgent(
				`<quiz_answer question=${JSON.stringify(quiz.question)}>\n${input.text}\n</quiz_answer>`,
			);
			return;
		}

		const text = input.text.trim();
		if (!text) throw new InputError("empty message");
		let prefix = "";
		let shown: { path: string; ranges: LineRange[] } | undefined;
		if (input.selection && input.selection.lines.length > 0) {
			const pane = this.#state.panes.find(
				(p) => p.id === input.selection?.paneId,
			);
			if (pane?.kind !== "code") {
				throw new InputError(
					`selection names a pane that is not showing code: ${input.selection.paneId}`,
				);
			}
			const total = lineCount(pane.text);
			const ranges = toRanges(input.selection.lines);
			const first = ranges.at(0);
			const last = ranges.at(-1);
			if (!first || !last || first.start < 1 || last.end > total) {
				throw new InputError(
					`selection is outside ${pane.path} (${total} lines)`,
				);
			}
			shown = { path: pane.path, ranges };
			prefix = `<selection path=${JSON.stringify(pane.path)} lines="${formatRanges(ranges)}">\n${excerpt(pane.text, ranges)}\n</selection>\n`;
		}
		// A message sent while a question is open means the learner moved on.
		// The card closes so the tutor is free to ask again.
		const open = this.#openQuiz();
		if (open) {
			open.skipped = true;
			this.#emit({ type: "item", item: open });
			prefix = `<quiz_skipped question=${JSON.stringify(open.question)} />\n${prefix}`;
		}
		this.#append({ kind: "learner", text, selection: shown });
		this.#toAgent(prefix + text);
	}

	close(): void {
		if (this.#state.status === "closed") return;
		this.#session.close();
		this.#setStatus("closed");
	}

	#openQuiz(): QuizItem | undefined {
		for (const item of this.#state.transcript) {
			if (item.kind === "quiz" && item.answer === undefined && !item.skipped) {
				return item;
			}
		}
		return undefined;
	}

	#setActivity(label: string | undefined): void {
		if (this.#state.activity === label) return;
		this.#state.activity = label;
		this.#emit({ type: "activity", label });
	}

	#toAgent(text: string): void {
		this.#setStatus("working");
		this.#session.send(text);
	}

	async #consume(): Promise<void> {
		for await (const event of this.#session.events) {
			if (event.type === "text_delta") {
				const item = this.#streaming.get(event.id);
				if (item) {
					item.text += event.text;
					this.#emit({ type: "item_delta", id: item.id, text: event.text });
				} else {
					this.#setActivity("Writing");
					const created = this.#append({
						kind: "tutor",
						text: event.text,
						streaming: true,
					});
					this.#streaming.set(event.id, created as TutorItem);
				}
			} else if (event.type === "text") {
				const item = event.id ? this.#streaming.get(event.id) : undefined;
				if (item && event.id) {
					this.#streaming.delete(event.id);
					item.text = event.text;
					delete item.streaming;
					this.#emit({ type: "item", item });
				} else {
					this.#setActivity(undefined);
					this.#append({ kind: "tutor", text: event.text });
				}
			} else if (event.type === "activity") {
				this.#setActivity(event.label);
			} else if (event.type === "turn_end") {
				this.#finishStreaming();
				this.#setActivity(undefined);
				if (event.status === "failed") {
					this.#append({
						kind: "tutor",
						text: `The tutor stopped early (${event.error ?? "unknown error"}). Send a message to continue.`,
					});
				}
				if (this.#state.status !== "closed") this.#setStatus("waiting");
			} else {
				this.#finishStreaming();
				this.#setActivity(undefined);
				this.#setStatus("closed", event.error);
			}
		}
	}

	/** Settles messages cut off mid-stream, for example by an interrupt. */
	#finishStreaming(): void {
		for (const item of this.#streaming.values()) {
			delete item.streaming;
			this.#emit({ type: "item", item });
		}
		this.#streaming.clear();
	}

	#append(item: DistributiveOmit<TranscriptItem, "id">): TranscriptItem {
		const full = { ...item, id: `t${this.#nextId++}` } as TranscriptItem;
		this.#state.transcript.push(full);
		this.#emit({ type: "item", item: full });
		return full;
	}

	#setStatus(status: TourStatus, error?: string): void {
		if (this.#state.status === status && !error) return;
		this.#state.status = status;
		if (error) this.#state.error = error;
		this.#emit({ type: "status", status, error });
	}

	#putPane(pane: Pane): void {
		const index = this.#state.panes.findIndex((p) => p.id === pane.id);
		if (index === -1) this.#state.panes.push(pane);
		else this.#state.panes[index] = pane;
		this.#state.focus = pane.id;
		this.#reportedPaneErrors.delete(pane.id);
		this.#emit({ type: "pane", pane });
		this.#emit({ type: "focus", id: pane.id });
	}

	#emit(event: TourEvent): void {
		const copy = structuredClone(event);
		for (const subscriber of this.#subscribers) subscriber(copy);
	}

	/** Resolves a tutor-supplied path and refuses anything outside the tour's directory. */
	async #resolveInCwd(path: string): Promise<{ full: string; rel: string }> {
		const root = await realpath(this.#state.cwd);
		const full = await realpath(resolve(root, path)).catch(() => {
			throw new Error(`no such file: ${path}`);
		});
		if (full !== root && !full.startsWith(root + sep)) {
			throw new Error(`${path} is outside the tour directory`);
		}
		if (!(await stat(full)).isFile()) throw new Error(`not a file: ${path}`);
		return { full, rel: relative(root, full) };
	}

	#tools(): ToolSpec[] {
		return [
			defineTool({
				name: "show_code",
				description:
					"Open a file from the tour directory in a code pane and bring it to the front. Highlight the line ranges the learner should look at and optionally attach a short note to them. Calling it again for the same path updates that pane.",
				input: {
					path: z
						.string()
						.describe("File path, relative to the tour directory"),
					highlights: z
						.array(
							z.object({
								start: z.number().int().min(1),
								end: z.number().int().min(1),
							}),
						)
						.default([])
						.describe("1-based inclusive line ranges to highlight"),
					note: z
						.string()
						.optional()
						.describe(
							"One or two sentences shown beside the highlighted lines",
						),
				},
				handler: async ({ path, highlights, note }) => {
					const { full, rel } = await this.#resolveInCwd(path);
					const text = await readFile(full, "utf8");
					const total = lineCount(text);
					for (const range of highlights) {
						if (range.end < range.start || range.end > total) {
							throw new Error(
								`highlight ${range.start}-${range.end} does not fit ${rel}, which has ${total} lines`,
							);
						}
					}
					const id = `code:${rel}`;
					this.#putPane({
						id,
						kind: "code",
						title: rel,
						path: rel,
						text,
						highlights,
						note,
					});
					return `Showing ${rel} (${total} lines) in pane ${id}.`;
				},
			}),
			defineTool({
				name: "show_markdown",
				description:
					"Show a markdown document in a pane: a summary, a comparison table, a worked example. Use the same id to replace an earlier pane. Conversation with the learner goes in your reply, not here.",
				input: {
					id: z.string().describe("Short stable name for this pane"),
					title: z.string(),
					markdown: z.string(),
				},
				handler: async ({ id, title, markdown }) => {
					const paneId = `md:${id}`;
					this.#putPane({ id: paneId, kind: "markdown", title, markdown });
					return `Showing pane ${paneId}.`;
				},
			}),
			defineTool({
				name: "show_diagram",
				description:
					"Show a Mermaid diagram in a pane: a flowchart, sequence diagram, state diagram, class diagram or ER diagram. Prefer this for any diagram Mermaid can express. Use the same id to replace an earlier pane. If the diagram has a syntax error you are told in the next message.",
				input: {
					id: z.string().describe("Short stable name for this pane"),
					title: z.string(),
					mermaid: z.string().describe("Mermaid source, without code fences"),
				},
				handler: async ({ id, title, mermaid }) => {
					const paneId = `diagram:${id}`;
					this.#putPane({ id: paneId, kind: "diagram", title, mermaid });
					return `Showing pane ${paneId}.`;
				},
			}),
			defineTool({
				name: "show_html",
				description:
					"Show a self-contained HTML document in a pane, for what the other panes cannot express: a custom drawing (inline SVG or canvas), an animation, a small interactive demo. It runs sandboxed with scripts allowed and no network access. Use the same id to replace an earlier pane.",
				input: {
					id: z.string().describe("Short stable name for this pane"),
					title: z.string(),
					html: z.string(),
				},
				handler: async ({ id, title, html }) => {
					const paneId = `html:${id}`;
					this.#putPane({ id: paneId, kind: "html", title, html });
					return `Showing pane ${paneId}.`;
				},
			}),
			defineTool({
				name: "close_pane",
				description: "Close a pane that is no longer relevant.",
				input: {
					id: z.string().describe("Pane id as returned when it was shown"),
				},
				handler: async ({ id }) => {
					const index = this.#state.panes.findIndex((p) => p.id === id);
					if (index === -1) throw new Error(`no such pane: ${id}`);
					this.#state.panes.splice(index, 1);
					if (this.#state.focus === id) {
						this.#state.focus = this.#state.panes.at(-1)?.id;
					}
					this.#emit({ type: "pane_closed", id });
					return `Closed ${id}.`;
				},
			}),
			defineTool({
				name: "set_outline",
				description:
					"Set or revise the plan for the tour, one short title per step, and mark the step now in progress. Call it once you know the plan and whenever you move to another step or the plan changes.",
				input: {
					steps: z.array(z.string()).min(1),
					current: z
						.number()
						.int()
						.min(1)
						.optional()
						.describe("1-based number of the step in progress"),
				},
				handler: async ({ steps, current }) => {
					if (current !== undefined && current > steps.length) {
						throw new Error(
							`current is ${current} but there are ${steps.length} steps`,
						);
					}
					this.#state.outline = steps;
					this.#state.step = current === undefined ? undefined : current - 1;
					this.#emit({
						type: "outline",
						outline: steps,
						step: this.#state.step,
					});
					return "Outline updated.";
				},
			}),
			defineTool({
				name: "ask_quiz",
				description:
					"Put a question to the learner as a card in the conversation. Give choices for multiple choice, or none for a free-text answer. Only one question can be open at a time. After calling it, end your turn: the answer arrives as the next message, or a note that the learner moved on without answering.",
				input: {
					question: z.string(),
					choices: z.array(z.string()).default([]),
				},
				handler: async ({ question, choices }) => {
					const open = this.#openQuiz();
					if (open) {
						throw new Error(
							`A question is already open and unanswered: ${JSON.stringify(open.question)}. It is on the learner's screen. End your turn and wait for the answer.`,
						);
					}
					this.#append({ kind: "quiz", question, choices });
					return "The question is on the learner's screen as a card. Finish this turn now with a closing line of a few words, such as 'Over to you.' Do not call ask_quiz again and do not repeat the question. The answer arrives as the next message.";
				},
			}),
		];
	}
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown
	? Omit<T, K>
	: never;

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
