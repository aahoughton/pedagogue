import { resolve } from "node:path";
import {
	type CanUseTool,
	createSdkMcpServer,
	query,
	type SDKUserMessage,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import { activityLabel } from "./activity.ts";
import { Channel } from "./channel.ts";
import type {
	AgentDriver,
	AgentEvent,
	AgentSession,
	AgentStartOptions,
} from "./driver.ts";
import { decide } from "./permissions.ts";

const TOOL_SERVER = "tour";
const BUILT_IN_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"];

export interface ClaudeDriverOptions {
	apiKey: string;
	model?: string;
}

/** Hosts each tutor as its own Claude Code subprocess through the Agent SDK. */
export class ClaudeDriver implements AgentDriver {
	readonly #options: ClaudeDriverOptions;

	constructor(options: ClaudeDriverOptions) {
		if (!options.apiKey) throw new Error("ClaudeDriver needs an API key");
		this.#options = options;
	}

	async open(options: AgentStartOptions): Promise<AgentSession> {
		const input = new Channel<SDKUserMessage>();
		const events = new Channel<AgentEvent>();
		const scratchDir = resolve(options.scratchDir);

		const server = createSdkMcpServer({
			name: TOOL_SERVER,
			tools: options.tools.map((spec) =>
				tool(spec.name, spec.description, spec.input, async (args) => {
					try {
						const text = await spec.handler(args);
						return { content: [{ type: "text", text }] };
					} catch (error) {
						return {
							content: [{ type: "text", text: errorMessage(error) }],
							isError: true,
						};
					}
				}),
			),
		});

		const sandbox = {
			cwd: options.cwd,
			scratchDir,
			toolPrefix: `mcp__${TOOL_SERVER}__`,
		};
		// No tool is pre-approved, so every call is decided here and the agent
		// never waits on a prompt.
		const canUseTool: CanUseTool = async (toolName, toolInput) => {
			const decision = decide(sandbox, toolName, toolInput);
			return decision.allow
				? { behavior: "allow", updatedInput: toolInput }
				: { behavior: "deny", message: decision.reason };
		};

		const run = query({
			prompt: input,
			options: {
				cwd: options.cwd,
				additionalDirectories: [scratchDir],
				systemPrompt: options.systemPrompt,
				model: this.#options.model,
				tools: BUILT_IN_TOOLS,
				canUseTool,
				mcpServers: { [TOOL_SERVER]: server },
				// The tutor runs with this configuration only; the user's own Claude
				// Code settings, hooks and MCP servers stay out of it.
				settingSources: [],
				strictMcpConfig: true,
				includePartialMessages: true,
				env: { ...process.env, ANTHROPIC_API_KEY: this.#options.apiKey },
			},
		});

		let interrupted = false;
		// Text arrives twice: as stream events while it is written and inside the
		// finished assistant message. A message whose text was streamed is not
		// emitted again from the finished message.
		const streamed = new Set<string>();
		let messageId = "";
		const open = new Map<number, { id: string; text: string }>();
		void (async () => {
			try {
				for await (const message of run) {
					if (message.type === "stream_event") {
						if (message.parent_tool_use_id) continue;
						const event = message.event;
						if (event.type === "message_start") {
							messageId = event.message.id;
							open.clear();
						} else if (event.type === "content_block_start") {
							const kind = event.content_block.type;
							if (kind === "text") {
								open.set(event.index, {
									id: `${messageId}:${event.index}`,
									text: "",
								});
							} else if (kind === "thinking") {
								events.push({ type: "activity", label: "Thinking" });
							}
						} else if (event.type === "content_block_delta") {
							const block = open.get(event.index);
							if (block && event.delta.type === "text_delta") {
								block.text += event.delta.text;
								streamed.add(messageId);
								events.push({
									type: "text_delta",
									id: block.id,
									text: event.delta.text,
								});
							}
						} else if (event.type === "content_block_stop") {
							const block = open.get(event.index);
							open.delete(event.index);
							if (block?.text.trim()) {
								events.push({ type: "text", id: block.id, text: block.text });
							}
						}
					} else if (
						message.type === "assistant" &&
						!message.parent_tool_use_id
					) {
						for (const block of message.message.content) {
							if (block.type === "tool_use") {
								events.push({
									type: "activity",
									label: activityLabel(
										block.name,
										block.input as Record<string, unknown>,
										sandbox.toolPrefix,
									),
								});
							} else if (
								block.type === "text" &&
								block.text.trim() &&
								!streamed.has(message.message.id)
							) {
								events.push({ type: "text", text: block.text });
							}
						}
					} else if (message.type === "result") {
						if (message.subtype === "success") {
							events.push({ type: "turn_end", status: "completed" });
						} else if (interrupted) {
							events.push({ type: "turn_end", status: "interrupted" });
						} else {
							events.push({
								type: "turn_end",
								status: "failed",
								error: message.subtype,
							});
						}
						interrupted = false;
						streamed.clear();
					}
				}
				events.push({ type: "closed" });
			} catch (error) {
				events.push({ type: "closed", error: errorMessage(error) });
			} finally {
				events.end();
			}
		})();

		return {
			send(text) {
				input.push({
					type: "user",
					message: { role: "user", content: text },
					parent_tool_use_id: null,
					origin: { kind: "human" },
				});
			},
			async interrupt() {
				interrupted = true;
				await run.interrupt();
			},
			close() {
				input.end();
				run.close();
			},
			events,
		};
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
