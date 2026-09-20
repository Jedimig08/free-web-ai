import { describe, expect, test } from "bun:test";
import { handleChatCompletions } from "../src/openai/chat-completions.ts";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/openai/types.ts";
import { parseDeepSeekStream } from "../src/providers/deepseek/stream.ts";

function streamFromEvents(events: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			}
			controller.close();
		},
	});
}

function streamFromRaw(raw: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(raw));
			controller.close();
		},
	});
}

function createDeepSeekMockClient(events: string[]) {
	return {
		providerId: "deepseek-web",
		init: async () => {},
		sendMessage: async () => streamFromEvents(events),
		parseStream: async (body: ReadableStream<Uint8Array>, onDelta?: (delta: string) => void) =>
			parseDeepSeekStream(body, onDelta),
		listModels: () => [{ id: "deepseek", name: "DeepSeek" }],
	};
}

describe("parseDeepSeekStream: hidden thinking span", () => {
	test("hides response/thinking_content from the main response", async () => {
		const events = [
			JSON.stringify({ v: { response: { fragments: [] } } }),
			JSON.stringify({ p: "response/thinking_content", v: "Let me think this through." }),
			JSON.stringify({ p: "response/content", v: "Hello!" }),
			JSON.stringify({ p: "response/status", v: "FINISHED" }),
		];
		const deltas: string[] = [];

		const result = await parseDeepSeekStream(streamFromEvents(events), (delta) =>
			deltas.push(delta),
		);

		expect(result.text).toBe("Hello!");
		expect(result.thinkingText).toBe("Let me think this through.");
		// The reasoning span must never reach the live content stream either.
		expect(deltas.join("")).toBe("Hello!");
	});

	test("hides the snapshot thinking_content field", async () => {
		const events = [
			JSON.stringify({ v: { response: { thinking_content: "deep thought" } } }),
			JSON.stringify({ p: "response/content", v: "ok" }),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("ok");
		expect(result.thinkingText).toBe("deep thought");
	});

	test("classifies APPEND fragments and relative fragment deltas", async () => {
		const events = [
			JSON.stringify({ v: { response: { fragments: [] } } }),
			JSON.stringify({
				p: "response/fragments",
				o: "APPEND",
				v: [{ id: 1, type: "THINKING", content: "" }],
			}),
			JSON.stringify({ p: "response/fragments/-1/content", v: "step one" }),
			JSON.stringify({ p: "response/fragments/-1/content", v: " step two" }),
			JSON.stringify({
				p: "response/fragments",
				o: "APPEND",
				v: [{ id: 2, type: "RESPONSE", content: "" }],
			}),
			JSON.stringify({ p: "response/fragments/-1/content", v: "final answer" }),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("final answer");
		expect(result.thinkingText).toBe("step one step two");
	});

	test("splits typed fragment arrays into reasoning and answer", async () => {
		const events = [
			JSON.stringify({
				v: [
					{ id: 1, type: "THINKING", content: "reasoning" },
					{ id: 2, type: "RESPONSE", content: "answer" },
				],
			}),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("answer");
		expect(result.thinkingText).toBe("reasoning");
	});

	test("hides inline thinking tags from the main response", async () => {
		const events = [
			JSON.stringify({
				p: "response/content",
				v: "<thinking>hidden plan</thinking>visible answer",
			}),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("visible answer");
		expect(result.thinkingText).toBe("hidden plan");
	});

	test("drops DeepSeek end-of-thinking junk tokens", async () => {
		const events = [
			JSON.stringify({ p: "response/content", v: "Answer" }),
			JSON.stringify({ p: "response/content", v: "<｜end▁of▁thinking｜>" }),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("Answer");
	});

	test("reports the response message id as parent id", async () => {
		const ids: Array<string | number> = [];
		const events = [
			JSON.stringify({ response_message_id: 123 }),
			JSON.stringify({ p: "response/content", v: "hi" }),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events), undefined, (id) =>
			ids.push(id),
		);

		expect(ids).toEqual([123]);
		expect(result.text).toBe("hi");
	});

	test("handles SSE data split across chunks", async () => {
		const encoder = new TextEncoder();
		const payload =
			`data: ${JSON.stringify({ p: "response/thinking_content", v: "hidden" })}\n\n` +
			`data: ${JSON.stringify({ p: "response/content", v: "shown" })}\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of payload.match(/.{1,17}/gs) ?? []) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		const result = await parseDeepSeekStream(stream);

		expect(result.text).toBe("shown");
		expect(result.thinkingText).toBe("hidden");
	});
});

describe("merged deepseek model through chat completions", () => {
	const events = [
		JSON.stringify({ v: { response: { fragments: [] } } }),
		JSON.stringify({ p: "response/thinking_content", v: "hidden reasoning" }),
		JSON.stringify({ p: "response/content", v: "visible answer" }),
		JSON.stringify({ p: "response/status", v: "FINISHED" }),
	];

	test("non-streaming keeps reasoning out of content", async () => {
		const client = createDeepSeekMockClient(events);
		const body: ChatCompletionRequest = {
			model: "deepseek",
			messages: [{ role: "user", content: "Hi" }],
		};

		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(200);

		const json = (await res.json()) as ChatCompletionResponse;
		expect(json.choices[0]?.message.content).toBe("visible answer");
		expect(json.choices[0]?.message.reasoning_content).toBe("hidden reasoning");
	});

	test("streaming emits reasoning before content and never as content", async () => {
		const client = createDeepSeekMockClient(events);
		const body: ChatCompletionRequest = {
			model: "deepseek",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
		};

		const res = await handleChatCompletions(body, client as any);
		expect(res.status).toBe(200);

		const sse = await res.text();
		const contentChunks = [...sse.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map(
			(m) => m[1] ?? "",
		);

		expect(contentChunks.join("")).toBe("visible answer");
		expect(contentChunks.join("")).not.toContain("hidden reasoning");
		expect(sse).toContain('"reasoning_content":"hidden reasoning"');
		// Reasoning must be streamed before the answer chunk.
		expect(sse.indexOf('"reasoning_content"')).toBeLessThan(
			sse.indexOf('"content":"visible answer"'),
		);
	});
});

describe("parseDeepSeekStream: real merged-model fragment stream", () => {
	// Captured verbatim from chat.deepseek.com /api/v0/chat/completion: the
	// reasoning span is announced as a `THINK` fragment and its tokens continue
	// both on `response/fragments/-1/content` and as bare `{"v":"..."}` events.
	const raw = [
		"event: ready",
		'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
		"",
		"event: update_session",
		'data: {"updated_at":1789865677.12}',
		"",
		'data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","thinking_enabled":true,"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"We","elapsed_secs":null,"stage_id":1}],"conversation_mode":"DEFAULT"}}}',
		"",
		'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}',
		"",
		'data: {"v":" answer"}',
		'data: {"v":" user"}',
		"",
		'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.746689595}',
		"",
		'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"Hi","references":[],"stage_id":1}]}',
		"",
		'data: {"v":" there"}',
		"",
		'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":65},{"p":"quasi_status","v":"FINISHED"}]}',
		'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
		"",
		"event: title",
		'data: {"content":"Say hi one word"}',
		"",
		"event: close",
		'data: {"click_behavior":"none","auto_resume":false}',
		"",
	].join("\n");

	test("hides THINK fragment tokens that arrive as bare deltas", async () => {
		const deltas: string[] = [];
		const ids: Array<string | number> = [];

		const result = await parseDeepSeekStream(
			streamFromRaw(raw),
			(delta) => deltas.push(delta),
			(id) => ids.push(id),
		);

		expect(result.text).toBe("Hi there");
		expect(result.thinkingText).toBe("We need answer user");
		// Reasoning never reaches the live content stream.
		expect(deltas.join("")).toBe("Hi there");
		expect(ids).toEqual([2]);
	});

	test("does not duplicate content when the snapshot repeats", async () => {
		const events = [
			JSON.stringify({
				v: { response: { fragments: [{ id: 2, type: "THINK", content: "We" }] } },
			}),
			JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: " need" }),
			JSON.stringify({
				v: { response: { fragments: [{ id: 2, type: "THINK", content: "We need" }] } },
			}),
			JSON.stringify({
				p: "response/fragments",
				o: "APPEND",
				v: [{ id: 3, type: "RESPONSE", content: "Hi" }],
			}),
		];

		const result = await parseDeepSeekStream(streamFromEvents(events));

		expect(result.text).toBe("Hi");
		expect(result.thinkingText).toBe("We need");
	});
});
