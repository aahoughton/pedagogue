import assert from "node:assert/strict";
import { test } from "node:test";
import { Channel } from "./channel.ts";

async function collect<T>(channel: Channel<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of channel) values.push(value);
	return values;
}

test("delivers values pushed before and after the consumer starts, in order", async () => {
	const channel = new Channel<number>();
	channel.push(1);
	channel.push(2);
	const collected = collect(channel);
	await Promise.resolve();
	channel.push(3);
	channel.end();
	assert.deepEqual(await collected, [1, 2, 3]);
});

test("end finishes a waiting consumer", async () => {
	const channel = new Channel<string>();
	const collected = collect(channel);
	channel.end();
	assert.deepEqual(await collected, []);
});

test("values pushed after end are dropped", async () => {
	const channel = new Channel<string>();
	channel.push("a");
	channel.end();
	channel.push("b");
	assert.deepEqual(await collect(channel), ["a"]);
});
