import { describe, expect, test } from "bun:test";
import { parseChatGPTStream } from "../src/providers/chatgpt/stream.ts";
import { textToStream } from "../src/providers/shared/stream-helpers.ts";

const FULL = "Hello world. This is the second sentence. And a third one.";

/** Build an SSE body out of raw event objects. */
function sse(events: unknown[]): ReadableStream<Uint8Array> {
	const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
	return textToStream(body);
}

function messageSnapshot(id: string, text: string) {
	return {
		message: {
			id,
			author: { role: "assistant" },
			content: { content_type: "text", parts: [text] },
		},
	};
}

/** Assert the parsed answer is emitted exactly once (no appended duplicates). */
function expectSingleCopy(text: string) {
	expect(text).toBe(FULL);
}

describe("chatgpt stream parser — no duplicated output", () => {
	test("cumulative message snapshots only emit new text", async () => {
		const res = await parseChatGPTStream(
			sse([
				messageSnapshot("m1", FULL.slice(0, 12)),
				messageSnapshot("m1", FULL.slice(0, 35)),
				messageSnapshot("m1", FULL),
			]),
		);
		expectSingleCopy(res.text);
	});

	test("repeated identical snapshots are ignored", async () => {
		const res = await parseChatGPTStream(
			sse([
				messageSnapshot("m1", FULL.slice(0, 20)),
				messageSnapshot("m1", FULL.slice(0, 20)),
				messageSnapshot("m1", FULL),
				messageSnapshot("m1", FULL),
			]),
		);
		expectSingleCopy(res.text);
	});

	test("p/v replace patches only emit the changed suffix", async () => {
		const res = await parseChatGPTStream(
			sse([
				{ p: "/message/content/parts/0", o: "replace", v: FULL.slice(0, 12) },
				{ p: "/message/content/parts/0", o: "replace", v: FULL.slice(0, 35) },
				{ p: "/message/content/parts/0", o: "replace", v: FULL },
			]),
		);
		expectSingleCopy(res.text);
	});

	test("p/v replace patches without an explicit op are snapshots", async () => {
		const res = await parseChatGPTStream(
			sse([
				{ p: "/message/content/parts/0", v: FULL.slice(0, 12) },
				{ p: "/message/content/parts/0", v: FULL.slice(0, 35) },
				{ p: "/message/content/parts/0", v: FULL },
			]),
		);
		expectSingleCopy(res.text);
	});

	test("p/v append patches are concatenated", async () => {
		const res = await parseChatGPTStream(
			sse([
				{ p: "/message/content/parts/0", o: "append", v: FULL.slice(0, 12) },
				{ p: "/message/content/parts/0", o: "append", v: FULL.slice(12, 35) },
				{ p: "/message/content/parts/0", o: "append", v: FULL.slice(35) },
			]),
		);
		expectSingleCopy(res.text);
	});

	test("v-array snapshots only emit new text", async () => {
		const res = await parseChatGPTStream(
			sse([
				{ v: [{ type: "text", content: FULL.slice(0, 12) }] },
				{ v: [{ type: "text", content: FULL.slice(0, 35) }] },
				{ v: [{ type: "text", content: FULL }] },
			]),
		);
		expectSingleCopy(res.text);
	});

	test("mixed snapshot and patch channels do not double up", async () => {
		const res = await parseChatGPTStream(
			sse([
				messageSnapshot("m1", FULL.slice(0, 20)),
				{ p: "/message/content/parts/0", o: "replace", v: FULL.slice(0, 40) },
				messageSnapshot("m1", FULL),
			]),
		);
		expectSingleCopy(res.text);
	});

	test("top-level content snapshots do not double up", async () => {
		const res = await parseChatGPTStream(
			sse([{ content: FULL.slice(0, 12) }, { content: FULL.slice(0, 35) }, { content: FULL }]),
		);
		expectSingleCopy(res.text);
	});

	test("inline think tags still split reasoning from content", async () => {
		const open = "<" + "thinking>";
		const close = "</" + "thinking>";
		const res = await parseChatGPTStream(
			sse([messageSnapshot("m1", `before ${open}some reasoning${close} after`)]),
		);
		expect(res.text).toBe("before  after");
		expect(res.thinkingText).toBe("some reasoning");
	});

	test("streamed deltas reach onDelta in order", async () => {
		const deltas: string[] = [];
		await parseChatGPTStream(
			sse([messageSnapshot("m1", FULL.slice(0, 12)), messageSnapshot("m1", FULL)]),
			(d) => deltas.push(d),
		);
		expect(deltas.join("")).toBe(FULL);
	});
});
