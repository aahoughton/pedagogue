import type { z } from "zod";

/**
 * A tool the daemon offers to a tutor agent. It is defined once, independent of
 * transport: a driver decides how its agent reaches the handler (in-process for the
 * Claude Agent SDK, an MCP endpoint for agents that cannot take in-process tools).
 */
export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
	name: string;
	description: string;
	input: Shape;
	/** Returns the text the agent sees as the tool result. Throw to report an error. */
	handler(args: z.infer<z.ZodObject<Shape>>): Promise<string>;
}

export type AgentEvent =
	/**
	 * A piece of prose as the agent writes it. Pieces with the same `id` belong
	 * to one message and are followed by a `text` event with that id. A driver
	 * that cannot stream sends only `text` events.
	 */
	| { type: "text_delta"; id: string; text: string }
	/** A complete piece of prose the agent addressed to the learner. */
	| { type: "text"; id?: string; text: string }
	/** A few words on what the agent is doing while it has nothing to show yet. */
	| { type: "activity"; label: string }
	/** The agent stopped responding to the input it had and is waiting for more. */
	| {
			type: "turn_end";
			status: "completed" | "interrupted" | "failed";
			error?: string;
	  }
	/** The session is over. No further events follow. */
	| { type: "closed"; error?: string };

export interface AgentSession {
	/**
	 * Identifies this conversation to the driver that created it. Passing it to
	 * `open` later continues the conversation, including from a new process.
	 */
	readonly resumeToken: string;
	/**
	 * Queue a learner message. It starts a turn when the agent is idle and is
	 * taken up after the current turn otherwise.
	 */
	send(text: string): void;
	/** Stop the current turn. The session stays usable. */
	interrupt(): Promise<void>;
	/** End the session and release its process. */
	close(): void;
	/** Single consumer. Ends after a `closed` event. */
	events: AsyncIterable<AgentEvent>;
}

export interface AgentStartOptions {
	/** Directory the agent explains. The agent may read it and must not write to it. */
	cwd: string;
	/** The only directory the agent may write to. */
	scratchDir: string;
	systemPrompt: string;
	tools: ToolSpec[];
	/**
	 * Continue the conversation a previous session reported. If it cannot be
	 * restored, the session ends with a `closed` event carrying the error.
	 */
	resumeToken?: string;
}

export interface AgentDriver {
	/**
	 * Starts an agent that can read `cwd`, write only to `scratchDir`, and never
	 * waits for an approval. Rejects if the agent cannot be started that way.
	 */
	open(options: AgentStartOptions): Promise<AgentSession>;
}

export function defineTool<Shape extends z.ZodRawShape>(
	spec: ToolSpec<Shape>,
): ToolSpec {
	return spec as unknown as ToolSpec;
}
