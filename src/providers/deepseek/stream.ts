import type { StreamResult } from "../types.ts";

const JUNK_TOKENS = new Set([
	"<｜end▁of▁thinking｜>",
	"<|end▁of▁thinking|>",
	"<｜end_of_thinking｜>",
	"<|end_of_thinking|>",
	"<|endoftext|>",
]);

/**
 * DeepSeek merged the old `deepseek-chat` / `deepseek-reasoner` server models
 * into a single model whose reasoning is rendered as a collapsible (hideable)
 * "thinking" span. The stream therefore carries both spans at once and the
 * reasoning must never leak into the main response content.
 */
type SpanKind = "text" | "thinking";

/**
 * Fragment types that describe the hideable reasoning span. DeepSeek announces
 * its reasoning fragment as `THINK` and the answer fragment as `RESPONSE`.
 */
const THINKING_FRAGMENT_TYPE_RE = /THINK|REASON|THOUGHT|COT|CHAIN_OF_THOUGHT/;

/** `p` paths that carry the reasoning span (e.g. `response/thinking_content`). */
const THINKING_PATH_RE = /thinking|reasoning|thought|chain_of_thought/i;

/** `p` paths that carry the visible answer. */
const FRAGMENT_CONTENT_PATH_RE = /^response\/fragments\/([^/]+)\/content$/i;

/** Inline reasoning tags a provider may emit inside the text stream. */
const THINKING_SPAN_RE =
	/<(?:think(?:ing)?|thought)\b[^<>]*>([\s\S]*?)<\/(?:think(?:ing)?|thought)\s*>/gi;

function isThinkingPath(path: string): boolean {
	return THINKING_PATH_RE.test(path);
}

function isContentPath(path: string): boolean {
	return path === "content" || path.endsWith("/content") || path.includes("/choices");
}

function normalizeFragmentKind(type: unknown): SpanKind {
	if (typeof type !== "string") return "text";
	const normalized = type
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	return THINKING_FRAGMENT_TYPE_RE.test(normalized) ? "thinking" : "text";
}

export async function parseDeepSeekStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onParentMessageId?: (id: string | number) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let thinkingText = "";

	let currentMode: "text" | "thinking" | "tool_call" = "text";
	let tagBuffer = "";

	// Fragment registry: DeepSeek streams the collapsed response as typed
	// fragments (`THINK` = hideable reasoning span, `RESPONSE` = the answer).
	// The fragment currently streaming is announced in the response snapshot and
	// its tokens then arrive either on `response/fragments/-1/content` or as
	// bare `{"v":"..."}` events without any `p` path, so the active span kind
	// has to be tracked to keep reasoning out of the answer.
	const fragmentKinds = new Map<number, SpanKind>();
	let activeFragmentKind: SpanKind = "text";

	const registerFragment = (frag: unknown, activate: boolean): SpanKind => {
		const record = frag as { id?: unknown; type?: unknown } | null;
		const kind = normalizeFragmentKind(record?.type);
		const rawId = record?.id;
		const id = typeof rawId === "number" ? rawId : Number(rawId);
		if (Number.isFinite(id)) {
			fragmentKinds.set(id, kind);
		}
		if (activate) activeFragmentKind = kind;
		return kind;
	};

	const resolveFragmentKind = (rawIndex: string): SpanKind => {
		const index = Number(rawIndex);
		if (!Number.isFinite(index)) return "text";
		if (index < 0) return activeFragmentKind;
		return fragmentKinds.get(index) ?? "text";
	};

	const emitText = (delta: string) => {
		if (!delta || JUNK_TOKENS.has(delta)) return;
		text += delta;
		onDelta?.(delta);
	};

	const emitThinking = (delta: string) => {
		if (!delta || JUNK_TOKENS.has(delta)) return;
		thinkingText += delta;
	};

	const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
		if (!delta) return;
		if (forceType === "thinking") {
			emitThinking(delta);
			return;
		}
		tagBuffer += delta;

		const checkTags = () => {
			const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought)\b[^<>]*>/i);
			const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought)\b[^<>]*>/i);
			const toolCallStartMatch =
				tagBuffer.match(
					/<tool_call\s+(?:id=['"]?([^'"]+)['"]?\s+)?name=['"]?([^'"]+)['"]?(?:\s+id=['"]?([^'"]+)['"]?)?\s*>/i,
				) || tagBuffer.match(/<tool_call\s+id=['"]?([^'"]+)['"]?\s*>/i);
			const toolCallEndMatch = tagBuffer.match(/<\/tool_call\b[^<>]*>/i);

			const indices = [
				{
					type: "think_start" as const,
					idx: thinkStartMatch?.index ?? -1,
					len: thinkStartMatch?.[0].length ?? 0,
				},
				{
					type: "think_end" as const,
					idx: thinkEndMatch?.index ?? -1,
					len: thinkEndMatch?.[0].length ?? 0,
				},
				{
					type: "tool_start" as const,
					idx: toolCallStartMatch?.index ?? -1,
					len: toolCallStartMatch?.[0].length ?? 0,
					name: toolCallStartMatch?.[2] || toolCallStartMatch?.[1] || "",
				},
				{
					type: "tool_end" as const,
					idx: toolCallEndMatch?.index ?? -1,
					len: toolCallEndMatch?.[0].length ?? 0,
				},
			]
				.filter((t) => t.idx !== -1)
				.toSorted((a, b) => a.idx - b.idx);

			if (indices.length > 0) {
				const first = indices[0];
				if (!first) return;
				const before = tagBuffer.slice(0, first.idx);
				if (before) {
					if (currentMode === "thinking") emitThinking(before);
					else if (currentMode === "tool_call") emitText(before);
					else emitText(before);
				}
				if (first.type === "think_start") {
					currentMode = "thinking";
				} else if (first.type === "think_end") {
					currentMode = "text";
				} else if (first.type === "tool_start") {
					currentMode = "tool_call";
				} else if (first.type === "tool_end") {
					currentMode = "text";
				}
				tagBuffer = tagBuffer.slice(first.idx + first.len);
				checkTags();
			} else {
				const lastAngle = tagBuffer.lastIndexOf("<");
				if (lastAngle === -1) {
					if (currentMode === "thinking") emitThinking(tagBuffer);
					else if (currentMode === "tool_call") emitText(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				} else if (lastAngle > 0) {
					const safe = tagBuffer.slice(0, lastAngle);
					if (currentMode === "thinking") emitThinking(safe);
					else if (currentMode === "tool_call") emitText(safe);
					else emitText(safe);
					tagBuffer = tagBuffer.slice(lastAngle);
				}
			}
		};
		checkTags();
	};

	const processLine = (line: string) => {
		if (!line) return;
		if (line.startsWith("event: ")) return;

		if (line.startsWith("data: ")) {
			const dataStr = line.slice(6).trim();
			if (dataStr === "[DONE]" || !dataStr) return;

			try {
				const data = JSON.parse(dataStr) as Record<string, unknown>;

				if (
					typeof data.response_message_id === "number" ||
					typeof data.response_message_id === "string"
				) {
					onParentMessageId?.(data.response_message_id as string | number);
				}

				const pField = data.p;
				const pStr = typeof pField === "string" ? pField : "";
				const isAppend = data.o === "APPEND";

				// Reasoning span first: paths like `response/thinking_content`
				// also contain the substring "content", and the fragment path
				// `response/fragments/<id>/content` may carry either span.
				if (typeof data.v === "string") {
					const fragmentMatch = pStr.match(FRAGMENT_CONTENT_PATH_RE);
					if (isThinkingPath(pStr) || data.type === "thinking") {
						pushDelta(data.v, "thinking");
						return;
					}
					if (fragmentMatch) {
						if (resolveFragmentKind(fragmentMatch[1] ?? "") === "thinking") {
							pushDelta(data.v, "thinking");
						} else {
							pushDelta(data.v);
						}
						return;
					}
				}

				if (data.type === "thinking" && typeof data.content === "string") {
					pushDelta(data.content, "thinking");
					return;
				}

				if (typeof data.v === "string" && isContentPath(pStr)) {
					pushDelta(data.v);
					return;
				}

				// DeepSeek streams the tokens of the fragment that is currently
				// active as bare `{"v":"..."}` events without a `p` path, so they
				// inherit the active fragment's span (reasoning or answer).
				if (typeof data.v === "string" && !pField) {
					if (activeFragmentKind === "thinking") pushDelta(data.v, "thinking");
					else pushDelta(data.v);
					return;
				}

				if (data.type === "text" && typeof data.content === "string") {
					pushDelta(data.content);
					return;
				}

				if (data.type === "search_result" || pStr.includes("search_results")) {
					const searchData = data.v ?? data.content;
					const query =
						typeof searchData === "string" ? searchData : (searchData as { query?: string })?.query;
					if (query) {
						pushDelta(`\n> [Researching: ${query}...]\n`);
					}
					return;
				}

				if (Array.isArray(data.v)) {
					const fragmentItems = data.v as Array<Record<string, unknown>>;
					const looksLikeFragments = fragmentItems.some(
						(item) => item && typeof item === "object" && ("type" in item || "content" in item),
					);
					if (pStr.includes("fragments") || looksLikeFragments) {
						for (const frag of fragmentItems) {
							const kind = registerFragment(frag, isAppend || pStr.includes("fragments"));
							const content = frag.content;
							if (typeof content === "string" && content) {
								if (kind === "thinking") pushDelta(content, "thinking");
								else pushDelta(content);
							}
						}
						return;
					}
				}

				const responseObj = (data.v as { response?: Record<string, unknown> } | undefined)
					?.response;
				if (responseObj && typeof responseObj === "object") {
					const snapshotFragments = responseObj.fragments;
					if (Array.isArray(snapshotFragments)) {
						let lastKind: SpanKind = activeFragmentKind;
						let sawFragment = false;
						for (const frag of snapshotFragments as Array<Record<string, unknown>>) {
							// A fragment that was already announced is emitted through
							// its deltas; re-emitting a repeated snapshot would
							// duplicate the text.
							const rawId = (frag as { id?: unknown }).id;
							const id = typeof rawId === "number" ? rawId : Number(rawId);
							const known = Number.isFinite(id) && fragmentKinds.has(id);
							lastKind = registerFragment(frag, false);
							sawFragment = true;
							const content = frag.content;
							if (!known && typeof content === "string" && content) {
								if (lastKind === "thinking") pushDelta(content, "thinking");
								else pushDelta(content);
							}
						}
						// The last fragment of a snapshot is the one streaming now.
						if (sawFragment) activeFragmentKind = lastKind;
						return;
					}
					const snapshotThinking =
						responseObj.thinking_content ?? responseObj.reasoning_content ?? responseObj.thinking;
					if (typeof snapshotThinking === "string" && snapshotThinking) {
						pushDelta(snapshotThinking, "thinking");
						return;
					}
				}

				const choice = (
					data.choices as Array<{
						delta?: {
							reasoning_content?: string;
							reasoning?: string;
							thinking?: string;
							content?: string;
						};
					}>
				)?.[0];
				if (choice?.delta) {
					if (choice.delta.reasoning_content) {
						pushDelta(choice.delta.reasoning_content, "thinking");
					}
					if (choice.delta.reasoning) {
						pushDelta(choice.delta.reasoning, "thinking");
					}
					if (choice.delta.thinking) {
						pushDelta(choice.delta.thinking, "thinking");
					}
					if (choice.delta.content) {
						pushDelta(choice.delta.content);
					}
				}
			} catch {
				// ignore partial JSON
			}
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) processLine(buffer.trim());
				if (tagBuffer) {
					if ((currentMode as string) === "thinking") emitThinking(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				}
				break;
			}
			const chunk = decoder.decode(value, { stream: true });
			const combined = buffer + chunk;
			const parts = combined.split("\n");
			buffer = parts.pop() || "";
			for (const part of parts) {
				processLine(part.trim());
			}
		}
	} finally {
		reader.releaseLock();
	}

	// Safety net: if a reasoning span ever reaches the text stream wrapped in
	// `<thinking>`-style tags, hide it from the main response too.
	const finalText = text.replace(THINKING_SPAN_RE, (_match, span: string) => {
		if (span) thinkingText += span;
		return "";
	});

	return { text: finalText.trim(), thinkingText: thinkingText.trim() };
}
