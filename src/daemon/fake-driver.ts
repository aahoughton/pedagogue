import { z } from "zod";
import { Channel } from "./channel.ts";
import type {
	AgentDriver,
	AgentEvent,
	AgentSession,
	AgentStartOptions,
} from "./driver.ts";

/**
 * A scripted stand-in for an agent. Tests read what the walkthrough sent it, call the
 * tools it was given, and emit agent events by hand.
 */
export class FakeDriver implements AgentDriver {
	readonly sessions: FakeSession[] = [];

	async open(options: AgentStartOptions): Promise<AgentSession> {
		const session = new FakeSession(options);
		this.sessions.push(session);
		return session;
	}
}

export class FakeSession implements AgentSession {
	readonly options: AgentStartOptions;
	readonly resumeToken: string;
	readonly received: string[] = [];
	readonly events = new Channel<AgentEvent>();
	static count = 0;
	interrupts = 0;
	closed = false;

	constructor(options: AgentStartOptions) {
		this.options = options;
		this.resumeToken = options.resumeToken ?? `fake-${++FakeSession.count}`;
	}

	send(text: string): void {
		this.received.push(text);
	}

	async interrupt(): Promise<void> {
		this.interrupts += 1;
	}

	close(): void {
		this.closed = true;
		this.events.end();
	}

	/** Calls a tool the way a driver would: validated input in, result text out. */
	async call(name: string, args: unknown): Promise<string> {
		const spec = this.options.tools.find((tool) => tool.name === name);
		if (!spec) throw new Error(`no such tool: ${name}`);
		return spec.handler(z.object(spec.input).parse(args));
	}

	/** Emits an event and waits for the walkthrough to process it. */
	async emit(event: AgentEvent): Promise<void> {
		this.events.push(event);
		await new Promise((resolve) => setImmediate(resolve));
	}
}
