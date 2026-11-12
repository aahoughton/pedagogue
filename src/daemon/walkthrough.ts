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
			/** Relative to the walkthrough's directory. */
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

/** `at` is when the item was added, as an ISO time. Items saved before it existed have none. */
export type TranscriptItem =
	| {
			id: string;
			at?: string;
			kind: "tutor";
			text: string;
			/** True while the tutor is still writing this message. */
			streaming?: boolean;
	  }
	| {
			id: string;
			at?: string;
			kind: "learner";
			text: string;
			selection?: { path: string; ranges: LineRange[] };
	  }
	/** A message from the daemon itself, such as a tutor that failed to start. */
	| { id: string; at?: string; kind: "notice"; text: string }
	| {
			id: string;
			at?: string;
			kind: "quiz";
			question: string;
			choices: string[];
			answer?: string;
			/** True when the learner moved on without answering. */
			skipped?: boolean;
	  };

type TutorItem = Extract<TranscriptItem, { kind: "tutor" }>;
type QuizItem = Extract<TranscriptItem, { kind: "quiz" }>;

export type WalkthroughStatus = "working" | "waiting" | "closed";

export interface WalkthroughState {
	id: string;
	cwd: string;
	/**
	 * The tutor's name for the walkthrough once it has given one; until then, the
	 * first line of the brief.
	 */
	title: string;
	/** The tutor's one-sentence description. Unset until it names the walkthrough. */
	summary?: string;
	status: WalkthroughStatus;
	/** Set when the walkthrough closed because of a failure. */
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

/** An incremental change to a WalkthroughState, applied in order by every viewer. */
export type WalkthroughEvent =
	/** `createdAt` is when the walkthrough started, as an ISO time. */
	| { type: "snapshot"; state: WalkthroughState; createdAt: string }
	| { type: "pane"; pane: Pane }
	| { type: "pane_closed"; id: string }
	| { type: "focus"; id: string }
	| { type: "outline"; outline: string[]; step?: number }
	| { type: "title"; title: string; summary: string }
	| { type: "item"; item: TranscriptItem }
	/** Text to add to the end of a tutor item that is still being written. */
	| { type: "item_delta"; id: string; text: string }
	| { type: "activity"; label?: string }
	| { type: "status"; status: WalkthroughStatus; error?: string };

export type LearnerInput =
	| { type: "message"; text: string; selection?: Selection }
	| { type: "answer"; quizId: string; text: string }
	/** A viewer could not render a pane, for example a diagram with a syntax error. */
	| { type: "pane_error"; paneId: string; message: string }
	| { type: "interrupt" };

export class InputError extends Error {}

/** What is saved for a walkthrough and what it is restored from. */
export interface WalkthroughRecord {
	version: 1;
	state: WalkthroughState;
	brief: string;
	/** The tutor conversation to continue, as reported by the driver. */
	resumeToken?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WalkthroughSettings {
	driver: AgentDriver;
	/** How long a tutor may wait for the learner before its process is stopped. */
	idleMs?: number;
	/** Called after every change to the walkthrough, for saving it. */
	onChange?: (walkthrough: Walkthrough) => void;
}

export interface WalkthroughOptions extends WalkthroughSettings {
	id: string;
	cwd: string;
	/** The only directory the tutor may write to. */
	scratchDir: string;
	brief: string;
}

/**
 * One tutoring session: the display state, the tutor agent that drives it, and the
 * learner input that feeds the agent. Viewers subscribe for events and can rebuild
 * the full state from a snapshot followed by the events after it.
 *
 * The tutor's process is not always running. A walkthrough restored from disk, or one
 * whose tutor sat idle, is dormant: it shows as waiting for the learner, and the
 * next input starts a tutor that continues the saved conversation.
 */
export class Walkthrough {
	readonly #state: WalkthroughState;
	readonly #settings: WalkthroughSettings;
	readonly #brief: string;
	readonly #scratchDir: string;
	readonly #createdAt: string;
	#updatedAt: string;
	/** The running tutor, if any. */
	#session: AgentSession | undefined;
	/** Set while a tutor is starting or running; cleared when the walkthrough goes dormant. */
	#opening: Promise<AgentSession> | undefined;
	#resumeToken: string | undefined;
	/** True from resuming a conversation until the tutor completes a turn in it. */
	#resuming = false;
	/** Messages sent to the tutor in the turn in progress. */
	#pending: string[] = [];
	#idleTimer: NodeJS.Timeout | undefined;
	readonly #subscribers = new Set<(event: WalkthroughEvent) => void>();
	#nextId = 1;
	/** Panes whose render failure the tutor has already been told about. */
	readonly #reportedPaneErrors = new Set<string>();
	/** Transcript items being streamed, by the driver's text id. */
	readonly #streaming = new Map<string, TutorItem>();

	/** Starts the tutor and hands it the brief. Rejects if the tutor cannot start. */
	static async open(options: WalkthroughOptions): Promise<Walkthrough> {
		const now = new Date().toISOString();
		const walkthrough = new Walkthrough(options, options.scratchDir, {
			version: 1,
			state: {
				id: options.id,
				cwd: options.cwd,
				title: firstLine(options.brief),
				status: "working",
				outline: [],
				panes: [],
				transcript: [],
			},
			brief: options.brief,
			createdAt: now,
			updatedAt: now,
		});
		walkthrough.#opening = walkthrough.#start(undefined);
		await walkthrough.#opening;
		walkthrough.#toAgent(options.brief);
		return walkthrough;
	}

	/** Brings back a saved walkthrough as dormant. A turn that was in progress is over. */
	static restore(
		record: WalkthroughRecord,
		settings: WalkthroughSettings & { scratchDir: string },
	): Walkthrough {
		const state = structuredClone(record.state);
		if (state.status === "working") state.status = "waiting";
		delete state.activity;
		for (const item of state.transcript) {
			if (item.kind === "tutor") delete item.streaming;
		}
		const walkthrough = new Walkthrough(settings, settings.scratchDir, {
			...record,
			state,
		});
		walkthrough.#nextId =
			1 +
			Math.max(0, ...state.transcript.map((item) => Number(item.id.slice(1))));
		return walkthrough;
	}

	private constructor(
		settings: WalkthroughSettings,
		scratchDir: string,
		record: WalkthroughRecord,
	) {
		this.#settings = settings;
		this.#scratchDir = scratchDir;
		this.#state = record.state;
		this.#brief = record.brief;
		this.#resumeToken = record.resumeToken;
		this.#createdAt = record.createdAt;
		this.#updatedAt = record.updatedAt;
	}

	/** Everything needed to restore this walkthrough later. */
	record(): WalkthroughRecord {
		return {
			version: 1,
			state: this.state,
			brief: this.#brief,
			resumeToken: this.#resumeToken,
			createdAt: this.#createdAt,
			updatedAt: this.#updatedAt,
		};
	}

	/** When the walkthrough started, as an ISO time. */
	get createdAt(): string {
		return this.#createdAt;
	}

	/** When the newest message in the conversation arrived; unset before the first. */
	get lastMessageAt(): string | undefined {
		return this.#state.transcript.findLast((item) => item.at)?.at;
	}

	get updatedAt(): string {
		return this.#updatedAt;
	}

	/** True while a tutor process is starting or running for this walkthrough. */
	get awake(): boolean {
		return this.#opening !== undefined;
	}

	get id(): string {
		return this.#state.id;
	}

	/** What the walkthrough was asked to explain, as given when it started. */
	get brief(): string {
		return this.#brief;
	}

	get state(): WalkthroughState {
		return structuredClone(this.#state);
	}

	/** Calls `listener` with a snapshot, then with every later event. Returns an unsubscribe function. */
	subscribe(listener: (event: WalkthroughEvent) => void): () => void {
		listener({
			type: "snapshot",
			state: this.state,
			createdAt: this.#createdAt,
		});
		this.#subscribers.add(listener);
		return () => this.#subscribers.delete(listener);
	}

	/** Throws InputError when the input does not fit the walkthrough's current state. */
	input(input: LearnerInput): void {
		if (this.#state.status === "closed") {
			throw new InputError("this walkthrough has ended");
		}
		if (input.type === "interrupt") {
			void this.#session?.interrupt();
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

	/** Ends the walkthrough for good. It stays readable and accepts no more input. */
	close(): void {
		if (this.#state.status === "closed") return;
		this.#detach();
		this.#setStatus("closed");
	}

	/**
	 * Stops the tutor's process and leaves the walkthrough as it is, to be woken by the
	 * next input. Used when the tutor has been idle and when the daemon stops.
	 */
	sleep(): void {
		if (this.#state.status === "closed") return;
		this.#detach();
		this.#finishStreaming();
		this.#setActivity(undefined);
		this.#setStatus("waiting");
	}

	#detach(): void {
		clearTimeout(this.#idleTimer);
		const session = this.#session;
		this.#session = undefined;
		this.#opening = undefined;
		this.#pending = [];
		session?.close();
	}

	async #start(resumeToken: string | undefined): Promise<AgentSession> {
		const session = await this.#settings.driver.open({
			cwd: this.#state.cwd,
			scratchDir: this.#scratchDir,
			systemPrompt: TUTOR_PROMPT,
			tools: this.#tools(),
			resumeToken,
		});
		this.#session = session;
		this.#resuming = resumeToken !== undefined;
		this.#resumeToken = session.resumeToken;
		void this.#consume(session);
		return session;
	}

	/**
	 * Replaces a tutor whose conversation could not be restored with a new one
	 * that is told what happened so far, then repeats the learner's last input.
	 */
	#startFresh(): void {
		const pending = this.#pending;
		this.#detach();
		this.#resumeToken = undefined;
		this.#append({
			kind: "notice",
			text: "The tutor's memory of this walkthrough could not be restored. A new tutor is picking up from what is on this page.",
		});
		this.#toAgent(
			`${this.#recap()}\n\nThe learner's latest input follows.\n\n${pending.join("\n\n")}`,
		);
	}

	/** The walkthrough so far, written for a tutor that has no memory of it. */
	#recap(): string {
		const state = this.#state;
		const lines = [
			"You are taking over a walkthrough in progress. The tutor before you is gone and its conversation could not be restored. The learner still sees everything described below. Continue from where it stopped; do not start over or re-introduce yourself.",
			"",
			`<original_brief>\n${this.#brief}\n</original_brief>`,
		];
		if (state.outline.length > 0) {
			const steps = state.outline.map(
				(title, i) =>
					`${i + 1}. ${title}${i === state.step ? " (in progress)" : ""}`,
			);
			lines.push(`<outline>\n${steps.join("\n")}\n</outline>`);
		}
		if (state.panes.length > 0) {
			const panes = state.panes.map((pane) => {
				const detail =
					pane.kind === "code"
						? `${pane.path}, highlights ${formatRanges(pane.highlights) || "none"}`
						: pane.title;
				return `- ${pane.id} (${detail})${pane.id === state.focus ? " [in front]" : ""}`;
			});
			lines.push(`<open_panes>\n${panes.join("\n")}\n</open_panes>`);
		}
		const said = state.transcript.flatMap((item) => {
			if (item.kind === "tutor") return [`Tutor: ${item.text}`];
			if (item.kind === "learner") return [`Learner: ${item.text}`];
			if (item.kind === "quiz") {
				const outcome = item.skipped
					? "skipped"
					: item.answer === undefined
						? "still open on the learner's screen"
						: `answered: ${item.answer}`;
				return [`Tutor asked: ${item.question} (${outcome})`];
			}
			return [];
		});
		lines.push(`<conversation>\n${said.join("\n\n")}\n</conversation>`);
		return lines.join("\n");
	}

	#fail(error: unknown): void {
		this.#detach();
		this.#append({
			kind: "notice",
			text: `The tutor could not start: ${error instanceof Error ? error.message : String(error)}. Send your message again to retry.`,
		});
		this.#setStatus("waiting");
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
		clearTimeout(this.#idleTimer);
		this.#setStatus("working");
		this.#pending.push(text);
		if (this.#session) {
			this.#session.send(text);
			return;
		}
		if (!this.#opening) {
			this.#setActivity("Waking the tutor");
			this.#opening = this.#start(this.#resumeToken);
		}
		const opening = this.#opening;
		opening.then(
			(session) => {
				// The walkthrough may have gone dormant or been closed while this one started.
				if (this.#opening === opening) session.send(text);
			},
			(error: unknown) => {
				if (this.#opening === opening) this.#fail(error);
			},
		);
	}

	async #consume(session: AgentSession): Promise<void> {
		for await (const event of session.events) {
			// A session that was detached may still deliver events; they no
			// longer belong to the walkthrough.
			if (session !== this.#session) return;
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
				if (event.status === "failed" && this.#resuming) {
					this.#startFresh();
					return;
				}
				this.#resuming = false;
				this.#pending = [];
				if (event.status === "failed") {
					this.#append({
						kind: "notice",
						text: `The tutor stopped early (${event.error ?? "unknown error"}). Send a message to continue.`,
					});
				}
				this.#setStatus("waiting");
				this.#armIdleTimer();
			} else {
				this.#finishStreaming();
				this.#setActivity(undefined);
				if (this.#resuming) {
					this.#startFresh();
					return;
				}
				this.#detach();
				this.#setStatus("closed", event.error);
			}
		}
	}

	#armIdleTimer(): void {
		clearTimeout(this.#idleTimer);
		const idleMs = this.#settings.idleMs;
		if (idleMs === undefined) return;
		this.#idleTimer = setTimeout(() => this.sleep(), idleMs);
		this.#idleTimer.unref();
	}

	/** Settles messages cut off mid-stream, for example by an interrupt. */
	#finishStreaming(): void {
		for (const item of this.#streaming.values()) {
			delete item.streaming;
			this.#emit({ type: "item", item });
		}
		this.#streaming.clear();
	}

	#append(item: DistributiveOmit<TranscriptItem, "id" | "at">): TranscriptItem {
		const full = {
			...item,
			id: `t${this.#nextId++}`,
			at: new Date().toISOString(),
		} as TranscriptItem;
		this.#state.transcript.push(full);
		this.#emit({ type: "item", item: full });
		return full;
	}

	#setStatus(status: WalkthroughStatus, error?: string): void {
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

	#emit(event: WalkthroughEvent): void {
		this.#updatedAt = new Date().toISOString();
		const copy = structuredClone(event);
		for (const subscriber of this.#subscribers) subscriber(copy);
		this.#settings.onChange?.(this);
	}

	/** Resolves a tutor-supplied path and refuses anything outside the walkthrough's directory. */
	async #resolveInCwd(path: string): Promise<{ full: string; rel: string }> {
		const root = await realpath(this.#state.cwd);
		const full = await realpath(resolve(root, path)).catch(() => {
			throw new Error(`no such file: ${path}`);
		});
		if (full !== root && !full.startsWith(root + sep)) {
			throw new Error(`${path} is outside the walkthrough directory`);
		}
		if (!(await stat(full)).isFile()) throw new Error(`not a file: ${path}`);
		return { full, rel: relative(root, full) };
	}

	#tools(): ToolSpec[] {
		return [
			defineTool({
				name: "show_code",
				description:
					"Open a file from the walkthrough directory in a code pane and bring it to the front. Highlight the line ranges the learner should look at and optionally attach a short note to them. Calling it again for the same path updates that pane.",
				input: {
					path: z
						.string()
						.describe("File path, relative to the walkthrough directory"),
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
				description: `Set or revise the plan for the walkthrough, one short title per step, and mark the step now in progress. Call it once you know the plan and whenever you move to another step or the plan changes. The first call must also name the walkthrough with title and summary; the learner picks walkthroughs from a list by them. Later calls leave them out unless the walkthrough has changed course.`,
				input: {
					steps: z.array(z.string()).min(1),
					title: z
						.string()
						.optional()
						.describe(
							`Name of the walkthrough in the walkthrough list: two to five words, at most ${TITLE_MAX} characters, naming the specific subject (the mechanism, the change, the ticket) so it cannot be confused with another walkthrough of the same codebase. No "walkthrough of", "explain" or "how".`,
						),
					summary: z
						.string()
						.optional()
						.describe(
							`One sentence, at most ${SUMMARY_MAX} characters, shown when the learner hovers over the title: what the walkthrough covers and in which repository, branch or pull request.`,
						),
					current: z
						.number()
						.int()
						.min(1)
						.optional()
						.describe("1-based number of the step in progress"),
				},
				handler: async ({ steps, current, title, summary }) => {
					if (current !== undefined && current > steps.length) {
						throw new Error(
							`current is ${current} but there are ${steps.length} steps`,
						);
					}
					const named = this.#state.summary !== undefined;
					if (!named && (title === undefined || summary === undefined)) {
						throw new Error(
							"this walkthrough has no name yet: call set_outline again with title and summary as well",
						);
					}
					const newTitle = checkLength("title", title, TITLE_MAX);
					const newSummary = checkLength("summary", summary, SUMMARY_MAX);
					if (newTitle !== undefined || newSummary !== undefined) {
						this.#state.title = newTitle ?? this.#state.title;
						this.#state.summary = newSummary ?? this.#state.summary;
						this.#emit({
							type: "title",
							title: this.#state.title,
							summary: this.#state.summary as string,
						});
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

const TITLE_MAX = 40;
const SUMMARY_MAX = 200;

/** Trims a name the tutor gave and refuses one that is empty or too long. */
function checkLength(
	what: string,
	text: string | undefined,
	max: number,
): string | undefined {
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (trimmed.length === 0 || trimmed.length > max) {
		throw new Error(
			`${what} is ${trimmed.length} characters; give 1 to ${max}`,
		);
	}
	return trimmed;
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
