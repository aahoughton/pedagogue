import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";
import type { Build } from "./build.ts";
import type { AgentDriver } from "./driver.ts";
import type { TourStore } from "./store.ts";
import { InputError, Tour, type TourRecord } from "./tour.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const UI_DIR = join(ROOT, "ui");

/** Files the browser may load, by URL path. Nothing else on disk is served. */
const ASSETS: Record<string, { file: string; type: string }> = {
	"/assets/tour.js": { file: join(UI_DIR, "tour.js"), type: "text/javascript" },
	"/assets/lines.js": {
		file: join(UI_DIR, "lines.js"),
		type: "text/javascript",
	},
	"/assets/index.js": {
		file: join(UI_DIR, "index.js"),
		type: "text/javascript",
	},
	"/assets/style.css": { file: join(UI_DIR, "style.css"), type: "text/css" },
	"/assets/favicon.svg": {
		file: join(UI_DIR, "favicon.svg"),
		type: "image/svg+xml",
	},
	"/vendor/marked.js": {
		file: join(ROOT, "node_modules/marked/lib/marked.esm.js"),
		type: "text/javascript",
	},
	"/vendor/purify.js": {
		file: join(ROOT, "node_modules/dompurify/dist/purify.es.mjs"),
		type: "text/javascript",
	},
	"/vendor/highlight.js": {
		file: join(
			ROOT,
			"node_modules/@highlightjs/cdn-assets/es/highlight.min.js",
		),
		type: "text/javascript",
	},
	"/vendor/highlight-light.css": {
		file: join(
			ROOT,
			"node_modules/@highlightjs/cdn-assets/styles/github.min.css",
		),
		type: "text/css",
	},
	"/vendor/highlight-dark.css": {
		file: join(
			ROOT,
			"node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
		),
		type: "text/css",
	},
};

const MERMAID_DIR = join(ROOT, "node_modules/mermaid/dist");
const MERMAID_PATH =
	/^\/vendor\/mermaid\/(mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[\w.-]+\.mjs)$/;

const StartTour = z.object({
	cwd: z.string().min(1),
	brief: z.string().trim().min(1),
});

const LearnerInput = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("message"),
		text: z.string(),
		selection: z
			.object({ paneId: z.string(), lines: z.array(z.number().int()) })
			.optional(),
	}),
	z.object({ type: z.literal("answer"), quizId: z.string(), text: z.string() }),
	z.object({
		type: z.literal("pane_error"),
		paneId: z.string(),
		message: z.string().max(2000),
	}),
	z.object({ type: z.literal("interrupt") }),
]);

export interface AppOptions {
	driver: AgentDriver;
	/** Where tours are saved and where their scratch directories live. */
	store: TourStore;
	/** Saved tours to bring back as dormant. */
	records?: TourRecord[];
	/** How long a tutor may wait for the learner before its process is stopped. */
	idleMs?: number;
	/** Base URL a browser on another machine uses to reach the daemon. */
	publicUrl: string;
	/**
	 * Hostnames a request may name in its Host header. A request for any other
	 * host is refused, which stops a web page that resolves its own domain to
	 * this machine from reaching the daemon.
	 */
	allowedHosts: string[];
	/** The running daemon's build, shown in the browser's titlebar. */
	build: Build;
}

export interface App {
	/** Handles one HTTP request. */
	handle(request: IncomingMessage, response: ServerResponse): void;
	/** Attaches WebSocket handling to a listening server. */
	attach(server: Server): void;
	tours: ReadonlyMap<string, Tour>;
	/**
	 * Stops every tutor and saves every tour. Tours keep their state and wake
	 * again after a restart.
	 */
	close(): Promise<void>;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export function createApp(options: AppOptions): App {
	const tours = new Map<string, Tour>();
	const settings = {
		driver: options.driver,
		idleMs: options.idleMs,
		onChange: (tour: Tour) => options.store.schedule(tour),
	};
	for (const record of options.records ?? []) {
		const id = record.state.id;
		tours.set(
			id,
			Tour.restore(record, {
				...settings,
				scratchDir: options.store.scratchDir(id),
			}),
		);
	}
	const sockets = new WebSocketServer({ noServer: true });
	const allowedHosts = new Set(
		options.allowedHosts.map((h) => h.toLowerCase()),
	);

	function checkHost(request: IncomingMessage): void {
		const host = hostname(request.headers.host);
		if (!host || !allowedHosts.has(host)) {
			throw new HttpError(403, `host not allowed: ${host ?? "(none)"}`);
		}
	}

	/** Browsers send Origin on writes and WebSocket upgrades; it must be this daemon. */
	function checkOrigin(request: IncomingMessage): void {
		const origin = request.headers.origin;
		if (origin === undefined) return;
		const originHost = URL.canParse(origin) ? new URL(origin).host : undefined;
		if (originHost !== request.headers.host) {
			throw new HttpError(403, `origin not allowed: ${origin}`);
		}
	}

	async function startTour(request: IncomingMessage): Promise<object> {
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			throw new HttpError(415, "send application/json");
		}
		const parsed = StartTour.safeParse(await readJson(request));
		if (!parsed.success) {
			throw new HttpError(400, 'expected {"cwd": string, "brief": string}');
		}
		const cwd = resolve(parsed.data.cwd);
		const info = await stat(cwd).catch(() => undefined);
		if (!info) throw new HttpError(400, `no such directory: ${cwd}`);
		if (!info.isDirectory())
			throw new HttpError(400, `not a directory: ${cwd}`);

		const id = randomUUID().slice(0, 8);
		const scratchDir = options.store.scratchDir(id);
		await mkdir(scratchDir, { recursive: true });
		const tour = await Tour.open({
			id,
			cwd,
			scratchDir,
			brief: parsed.data.brief,
			...settings,
		});
		tours.set(id, tour);
		options.store.schedule(tour);
		return { id, url: new URL(`/tours/${id}`, options.publicUrl).href };
	}

	async function route(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		checkHost(request);
		const { pathname } = new URL(request.url ?? "/", "http://daemon");
		const method = request.method ?? "GET";

		if (method === "GET" && pathname === "/") {
			return sendFile(response, join(UI_DIR, "index.html"), "text/html");
		}
		const asset = ASSETS[pathname];
		if (method === "GET" && asset) {
			return sendFile(response, asset.file, asset.type);
		}
		// Mermaid loads its diagram types as separate chunks, so its build
		// directory is served as a whole, limited to the module files in it.
		const mermaid = MERMAID_PATH.exec(pathname);
		if (method === "GET" && mermaid) {
			const file = join(MERMAID_DIR, mermaid[1] as string);
			if (!(await stat(file).catch(() => undefined))?.isFile()) {
				throw new HttpError(404, `not found: ${pathname}`);
			}
			return sendFile(response, file, "text/javascript");
		}
		if (pathname === "/about" && method === "GET") {
			return sendJson(response, 200, options.build);
		}
		if (pathname === "/tours" && method === "GET") {
			return sendJson(response, 200, {
				tours: [...tours.values()]
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
					.map((tour) => {
						const { id, cwd, title, status } = tour.state;
						return { id, cwd, title, status, updatedAt: tour.updatedAt };
					}),
			});
		}
		if (pathname === "/tours" && method === "POST") {
			checkOrigin(request);
			return sendJson(response, 201, await startTour(request));
		}
		const match = /^\/tours\/([a-z0-9]+)$/.exec(pathname);
		if (match) {
			const tour = tours.get(match[1] as string);
			if (!tour) throw new HttpError(404, `no such tour: ${match[1]}`);
			if (method === "GET") {
				return sendFile(response, join(UI_DIR, "tour.html"), "text/html");
			}
			if (method === "DELETE") {
				checkOrigin(request);
				tour.close();
				return sendJson(response, 200, { id: tour.id, status: "closed" });
			}
		}
		throw new HttpError(404, `not found: ${method} ${pathname}`);
	}

	return {
		tours,
		handle(request, response) {
			route(request, response).catch((error: unknown) => {
				const status = error instanceof HttpError ? error.status : 500;
				const message = error instanceof Error ? error.message : String(error);
				if (status === 500) console.error(`request failed: ${message}`);
				sendJson(response, status, { error: message });
			});
		},
		attach(server) {
			server.on("upgrade", (request, socket, head) => {
				let tour: Tour | undefined;
				try {
					checkHost(request);
					checkOrigin(request);
					const { pathname } = new URL(request.url ?? "/", "http://daemon");
					const match = /^\/tours\/([a-z0-9]+)\/ws$/.exec(pathname);
					tour = match ? tours.get(match[1] as string) : undefined;
					if (!tour) throw new HttpError(404, "no such tour");
				} catch (error) {
					const status = error instanceof HttpError ? error.status : 500;
					socket.end(`HTTP/1.1 ${status} Refused\r\n\r\n`);
					return;
				}
				const target = tour;
				sockets.handleUpgrade(request, socket, head, (ws) => {
					const unsubscribe = target.subscribe((event) =>
						ws.send(JSON.stringify(event)),
					);
					ws.on("close", unsubscribe);
					ws.on("message", (data) => {
						try {
							const input = LearnerInput.parse(JSON.parse(String(data)));
							target.input(input);
						} catch (error) {
							const message =
								error instanceof InputError
									? error.message
									: "the daemon could not read that message";
							ws.send(JSON.stringify({ type: "error", message }));
						}
					});
				});
			});
		},
		async close() {
			for (const tour of tours.values()) tour.sleep();
			sockets.close();
			await options.store.flush();
		},
	};
}

/** Starts an app on one address. Port 0 picks a free port. */
export async function listen(
	app: App,
	host: string,
	port: number,
): Promise<{ server: Server; port: number }> {
	const server = createServer((request, response) =>
		app.handle(request, response),
	);
	app.attach(server);
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(port, host, done);
	});
	return { server, port: (server.address() as AddressInfo).port };
}

function hostname(hostHeader: string | undefined): string | undefined {
	if (!hostHeader) return undefined;
	return URL.canParse(`http://${hostHeader}`)
		? new URL(`http://${hostHeader}`).hostname.toLowerCase()
		: undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > 1_000_000) throw new HttpError(413, "request body too large");
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "request body is not JSON");
	}
}

function sendJson(
	response: ServerResponse,
	status: number,
	body: object,
): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function sendFile(
	response: ServerResponse,
	file: string,
	type: string,
): Promise<void> {
	const body = await readFile(file);
	response.writeHead(200, {
		"content-type": `${type}; charset=utf-8`,
		"cache-control": "no-cache",
	});
	response.end(body);
}
