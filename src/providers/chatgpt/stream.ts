import type { StreamResult } from "../types.ts";

// Tokens that should be ignored (end-of-thinking markers etc.)
const JUNK_TOKENS = new Set([
	"<｜end▁of▁thinking｜>",
	"<|end▁of▁thinking|>",
	"<｜end_of_thinking｜>",
	"<|end_of_thinking|>",
	"<|endoftext|>",
]);

function stripEntityTags(text: string): string {
	// Extract middle text from entity citations: entity["company","OpenAI","AI research..."] → "OpenAI"
	let out = text.replace(/entity\s*(\[[^\]]*?\])\s*/g, (_, jsonStr: string) => {
		try {
			const arr = JSON.parse(jsonStr) as unknown[];
			if (Array.isArray(arr)) {
				if (arr.length >= 2 && typeof arr[1] === "string" && (arr[1] as string).trim()) {
					return arr[1] as string;
				}
				for (const v of arr) {
					if (
						typeof v === "string" &&
						v.trim() &&
						v !== "company" &&
						v !== "person" &&
						v !== "entity" &&
						v !== "organization"
					) {
						return v;
					}
				}
				if (typeof arr[0] === "string") return arr[0] as string;
			}
		} catch {
			// fallback: extract quoted strings
			const quotes = [...jsonStr.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
			if (quotes.length >= 2) return quotes[1]!;
			if (quotes.length === 1) return quotes[0]!;
		}
		return "";
	});
	out = out
		.replace(/[^]*?/g, "")
		.replace(/【[^】]*?】/g, "")
		.replace(/\[\^[^\]]*?\]/g, "");
	return out;
}

/** Length of the longest common prefix of two strings. */
function commonPrefixLen(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

export async function parseChatGPTStream(
	body: ReadableStream<Uint8Array>,
	onDelta?: (delta: string) => void,
	onMeta?: (meta: { conversationId?: string; parentMessageId?: string }) => void,
): Promise<StreamResult> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let thinkingText = "";
	// Watermarks of every byte already consumed per output channel. They are
	// used to turn cumulative snapshots (which ChatGPT sends in several
	// different shapes) into plain deltas without ever re-emitting text.
	let seenText = "";
	let seenThinking = "";
	// Current value of every JSON-patch path (the "p"/"v" stream dialect).
	const patchValues = new Map<string, string>();

	// Tag-based thinking detection (like deepseek-reasoner / qwen)
	let currentMode: "text" | "thinking" = "text";
	let tagBuffer = "";

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
			seenThinking += delta;
			emitThinking(delta);
			return;
		}
		if (forceType === "text") {
			seenText += delta;
			emitText(delta);
			return;
		}
		seenText += delta;
		tagBuffer += delta;

		const checkTags = () => {
			const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought|reasoning)\b[^<>]*>/i);
			const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought|reasoning)\b[^<>]*>/i);

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
			]
				.filter((t) => t.idx !== -1)
				.toSorted((a, b) => a.idx - b.idx);

			if (indices.length > 0) {
				const first = indices[0]!;
				const before = tagBuffer.slice(0, first.idx);
				if (before) {
					if (currentMode === "thinking") emitThinking(before);
					else emitText(before);
				}
				if (first.type === "think_start") {
					currentMode = "thinking";
				} else if (first.type === "think_end") {
					currentMode = "text";
				}
				tagBuffer = tagBuffer.slice(first.idx + first.len);
				checkTags();
			} else {
				const lastAngle = tagBuffer.lastIndexOf("<");
				if (lastAngle === -1) {
					if (currentMode === "thinking") emitThinking(tagBuffer);
					else emitText(tagBuffer);
					tagBuffer = "";
				} else if (lastAngle > 0) {
					const safe = tagBuffer.slice(0, lastAngle);
					if (currentMode === "thinking") emitThinking(safe);
					else emitText(safe);
					tagBuffer = tagBuffer.slice(lastAngle);
				}
			}
		};
		checkTags();
	};

	const flushTagBuffer = () => {
		if (!tagBuffer) return;
		if (currentMode === "thinking") emitThinking(tagBuffer);
		else emitText(tagBuffer);
		tagBuffer = "";
	};

	/**
	 * Emit only the part of `value` that has not been consumed yet.
	 *
	 * ChatGPT transports the answer in several different shapes, and the
	 * shapes do not agree on whether a value is a delta or a full snapshot:
	 *
	 *   - `message.content.parts[0]`               → cumulative snapshot
	 *   - `{ p: "/message/content/parts/0", v }`   → JSON patch, append OR replace
	 *   - `v: [{ content }]`                       → usually a snapshot
	 *   - plain `content` / `text` / `v` strings   → delta or snapshot
	 *
	 * Treating a snapshot as a delta appends the whole answer again, which is
	 * what produced the interleaved duplicate replies. Everything that can be
	 * a snapshot therefore goes through here, sized against the watermark of
	 * what we already emitted.
	 */
	const pushSnapshot = (value: string) => {
		if (!value) return;
		if (value.length <= seenText.length && seenText.startsWith(value)) {
			// Rewind or replay of an already emitted prefix — nothing new.
			return;
		}
		if (value.startsWith(seenText)) {
			pushDelta(value.slice(seenText.length));
			return;
		}
		// Diverged/rewritten snapshot: emit the changed suffix only.
		pushDelta(value.slice(commonPrefixLen(value, seenText)));
	};

	const pushThinkingSnapshot = (value: string) => {
		if (!value) return;
		if (value.length <= seenThinking.length && seenThinking.startsWith(value)) {
			return;
		}
		if (value.startsWith(seenThinking)) {
			pushDelta(value.slice(seenThinking.length), "thinking");
			return;
		}
		pushDelta(value.slice(commonPrefixLen(value, seenThinking)), "thinking");
	};

	/**
	 * Ambiguous channel: accept both deltas and cumulative snapshots.
	 * A delta can never start with the *entire* text emitted so far, so this
	 * is safe for both and still de-duplicates snapshots.
	 */
	const pushAuto = (value: string) => {
		if (!value) return;
		if (value.length > seenText.length && value.startsWith(seenText)) {
			pushDelta(value.slice(seenText.length));
			return;
		}
		pushDelta(value);
	};

	/** Apply one `{ p, o, v }` JSON-patch event. */
	const applyPatch = (path: string, op: string | undefined, value: string) => {
		if (!value) return;
		const isThinking = /reasoning|thinking|thought/i.test(path);
		const seen = isThinking ? seenThinking : seenText;
		const previous = patchValues.get(path) ?? "";

		if (op === "append") {
			const next = previous + value;
			patchValues.set(path, next);
			// Only emit what the global watermark has not seen yet, so a
			// replayed append cannot duplicate text.
			let delta = value;
			if (next.length <= seen.length && seen.startsWith(next)) delta = "";
			else if (next.length > seen.length && next.startsWith(seen)) delta = next.slice(seen.length);
			if (!delta) return;
			if (isThinking) pushDelta(delta, "thinking");
			else pushDelta(delta);
			return;
		}

		// "replace"/"add"/missing op: `value` is the complete new value for
		// this path. Diff it against the *global* watermark so snapshots from
		// different channels can never be emitted twice.
		patchValues.set(path, value);
		if (isThinking) pushThinkingSnapshot(value);
		else pushSnapshot(value);
	};

	const processLine = (line: string) => {
		if (!line?.startsWith("data: ")) {
			return;
		}

		const dataStr = line.slice(6).trim();
		if (dataStr === "[DONE]") {
			return;
		}
		if (!dataStr) {
			return;
		}

		try {
			const data = JSON.parse(dataStr) as Record<string, unknown>;

			// Meta tracking (conversation_id / message id)
			if (typeof data.conversation_id === "string") {
				onMeta?.({ conversationId: data.conversation_id });
			}
			const msg = data.message as
				| {
						id?: string;
						author?: { role?: string };
						role?: string;
						content?: {
							parts?: unknown[];
							content_type?: string;
							text?: string;
							thinking?: string;
							reasoning?: string;
						};
						metadata?: Record<string, unknown>;
				  }
				| undefined;
			if (msg?.id) {
				onMeta?.({ parentMessageId: msg.id });
			}

			// --- Structured thinking fields (deepseek-like / openai-like) ---
			// p/v reasoning channel (DeepSeek style, also possible for ChatGPT).
			// `v` may be an append delta OR the complete new value (o: "replace"),
			// so it has to go through the patch handler.
			const pField = data.p as string | undefined;
			const pStr = typeof pField === "string" ? pField : "";
			const opField = typeof data.o === "string" ? data.o : undefined;
			if (pStr && typeof data.v === "string" && /reasoning|thinking|thought/i.test(pStr)) {
				applyPatch(pStr, opField, data.v);
				return;
			}
			if (data.type === "thinking" && typeof data.content === "string") {
				pushThinkingSnapshot(data.content);
				return;
			}

			// reasoning_content in choices[0].delta (OpenAI style used by think models)
			const choice = (
				data.choices as
					| Array<{
							delta?: {
								reasoning_content?: string;
								reasoning?: string;
								thinking?: string;
								content?: string;
							};
					  }>
					| undefined
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
				// If there was reasoning, also handle content separately
				if (choice.delta.content) {
					pushDelta(choice.delta.content);
					return;
				}
				if (choice.delta.reasoning_content || choice.delta.reasoning || choice.delta.thinking) {
					return;
				}
			}

			// v as array of fragments (snapshot of the parts array). Each entry may
			// be a full value, so feed them through the patch/snapshot logic.
			if (Array.isArray(data.v)) {
				let handled = false;
				(data.v as Array<Record<string, unknown>>).forEach((frag, index) => {
					const content = String(frag.content ?? frag.text ?? "");
					if (!content) return;
					const isThinking =
						frag.type === "THINKING" || frag.type === "reasoning" || frag.type === "thinking";
					if (isThinking) {
						applyPatch(
							`/v/${index}/thinking`,
							typeof frag.o === "string" ? frag.o : undefined,
							content,
						);
					} else {
						applyPatch(
							`/v/${index}/content`,
							typeof frag.o === "string" ? frag.o : undefined,
							content,
						);
					}
					handled = true;
				});
				if (handled) return;
			}

			// ChatGPT specific: message.content with thinking type
			if (msg?.content) {
				const c = msg.content as Record<string, unknown>;
				// Handle explicit thinking content_type
				if (
					c.content_type === "thinking" ||
					c.content_type === "reasoning" ||
					c.content_type === "thoughts"
				) {
					const thoughtStr =
						(typeof c.thinking === "string" && c.thinking) ||
						(typeof c.reasoning === "string" && c.reasoning) ||
						(typeof c.text === "string" && c.text) ||
						"";
					if (thoughtStr) {
						pushThinkingSnapshot(thoughtStr);
						return;
					}
					// parts may contain thinking strings
					const partsThinking = c.parts as unknown[] | undefined;
					if (Array.isArray(partsThinking) && partsThinking.length > 0) {
						for (const p of partsThinking) {
							if (typeof p === "string" && p) pushThinkingSnapshot(p);
							else if (
								typeof p === "object" &&
								p !== null &&
								"text" in p &&
								typeof (p as { text?: string }).text === "string"
							) {
								pushThinkingSnapshot((p as { text: string }).text);
							}
						}
						return;
					}
				}

				// Also check metadata for reasoning
				if (msg.metadata) {
					const m = msg.metadata as Record<string, unknown>;
					const metaThinking =
						(typeof m.reasoning === "string" && m.reasoning) ||
						(typeof m.thinking === "string" && m.thinking) ||
						(typeof m.thought === "string" && m.thought) ||
						"";
					if (metaThinking) {
						pushThinkingSnapshot(metaThinking);
						// don't return, also process content below
					}
				}
			}

			// Standard ChatGPT content: message.content.parts[0] as string or {text: string}
			if (msg) {
				const role = msg.author?.role ?? msg.role;
				if (role && role !== "assistant") {
					return;
				}

				const rawPart = msg.content?.parts?.[0];
				const content =
					typeof rawPart === "string"
						? rawPart
						: typeof rawPart === "object" &&
								rawPart !== null &&
								"text" in rawPart &&
								typeof (rawPart as { text?: string }).text === "string"
							? (rawPart as { text: string }).text
							: undefined;
				if (typeof content === "string" && content) {
					// ChatGPT resends the whole message so far on every event.
					// pushSnapshot() converts that into deltas and ignores replays.
					// Content may also contain think tags inline (handled by pushDelta).
					pushSnapshot(content);
					return;
				}
			}

			// Generic fallback: data.text / data.content / data.delta strange shapes
			if (typeof data.text === "string" && data.text) {
				pushAuto(data.text);
				return;
			}
			if (typeof data.content === "string" && data.content) {
				// If not already handled as thinking, treat as text but also check for think tags
				pushAuto(data.content);
				return;
			}
			// Direct string v (content channel). Could be an append delta or a
			// replace snapshot depending on the dialect, so disambiguate.
			if (
				typeof data.v === "string" &&
				(!pField || pStr.includes("content") || pStr.includes("choices"))
			) {
				if (pStr) applyPatch(pStr, opField, data.v);
				else pushAuto(data.v);
				return;
			}
			if (data.type === "text" && typeof data.content === "string") {
				pushDelta(data.content);
				return;
			}
		} catch {
			// ignore partial or non-JSON lines
		}
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (buffer.trim()) {
					processLine(buffer.trim());
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

	// Flush any remaining tag-buffered content
	if (tagBuffer) {
		flushTagBuffer();
	}

	// Fallback: if thinking was embedded as </think> tags but we missed mode transitions due to full-content slicing,
	// also try to extract from final text (defensive).
	// We already handled via pushDelta tagging, but if text still contains tags, split them.
	if (!thinkingText && text.includes("<think")) {
		const extracted = extractThinkTags(text);
		if (extracted.thinking) {
			text = extracted.text;
			thinkingText = extracted.thinking;
		}
	}

	const cleanThinking = stripEntityTags(thinkingText).trim();

	return { text, thinkingText: cleanThinking };
}

function extractThinkTags(raw: string): { text: string; thinking: string } {
	let thinking = "";
	const re =
		/<(?:think|thinking|thought|reasoning)\b[^<>]*>([\s\S]*?)<\/(?:think|thinking|thought|reasoning)>/gi;
	for (const m of raw.matchAll(re)) {
		thinking += (thinking ? "\n" : "") + (m[1]?.trim() ?? "");
	}
	const text = raw.replace(re, "").trim();
	return { text, thinking };
}
