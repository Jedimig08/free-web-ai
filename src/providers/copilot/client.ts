import type { ElementHandle, Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseApiClient } from "../factory/base-api-client.ts";
import type { ApiClientConfig, NormalizedSendParams } from "../factory/types.ts";
import { parseCookieHeader } from "../shared/cookie-parser.ts";
import type { EvalResult } from "../shared/eval-helpers.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { StreamResult } from "../types.ts";
import type { CopilotWebAuth } from "./auth.ts";
import { parseCopilotStream } from "./stream.ts";

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * The redesigned Copilot chat UI (copilot.com) renders each turn as a
 * `[data-testid="m365-chat-llm-web-ui-chat-message"]` node that holds BOTH the
 * user's bubble (`[data-testid="chatQuestion"]`) and the assistant's reply.
 *
 * Only reply containers are listed here: a generic `[class*="message"]` match
 * resolves to `fai-UserMessage__message` — the user's own bubble — which is how
 * the gateway used to hand the prompt back as if it were the answer.
 */
export const COPILOT_REPLY_SELECTORS = [
	'[data-testid="markdown-reply"]',
	'[data-testid="copilot-message-reply-div"]',
	'[data-testid="copilot-message-div"]',
];

const COPILOT_INPUT_SELECTORS = [
	'[contenteditable="true"]',
	"textarea[placeholder]",
	"textarea",
	'div[role="textbox"]',
	'[role="textbox"]',
];

/** Placeholder copy the UI shows while a reply is still being generated. */
const COPILOT_PLACEHOLDER_RE =
	/^(thinking|thinking…|working on it|searching|browsing|generating|analysing|analyzing|\.{1,3}|…)$/i;

/**
 * TFG model id → label shown by the composer's model picker on copilot.com.
 * Selecting one of these actually switches the mode the site sends upstream.
 */
const COPILOT_MODE_LABELS: Record<string, string> = {
	"copilot-auto": "Auto",
	"copilot-quick": "Quick response",
	"copilot-think-deeper": "Think deeper",
};

/**
 * Extra aliases (normalised: lowercase, alphanumerics only) so ids like
 * `copilot_fast` or a bare `think` still map onto a picker option.
 */
const COPILOT_MODE_ALIASES: Record<string, string> = {
	auto: "Auto",
	automatic: "Auto",
	magic: "Auto",
	quick: "Quick response",
	quickresponse: "Quick response",
	fast: "Quick response",
	think: "Think deeper",
	thinkdeeper: "Think deeper",
	reasoning: "Think deeper",
	deepthink: "Think deeper",
};

function normalizeModeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COPILOT_MODE_LOOKUP: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(COPILOT_MODE_LABELS).map(([id, label]) => [normalizeModeKey(id), label]),
	),
	...COPILOT_MODE_ALIASES,
};

/**
 * Resolve a requested model id to the picker label that must be selected.
 * Returns null for unrecognised ids, in which case the composer keeps whatever
 * mode the user currently has selected.
 */
export function resolveCopilotModeLabel(modelId: string | undefined | null): string | null {
	if (!modelId) return null;
	// The registry also accepts the prefixed form ("copilot-web/copilot-auto"),
	// which reaches sendMessage untouched.
	const bare = modelId.includes("/") ? (modelId.split("/").at(-1) ?? "") : modelId;
	return COPILOT_MODE_LOOKUP[normalizeModeKey(bare)] ?? null;
}

export class CopilotWebClient extends BaseApiClient<CopilotWebAuth> {
	readonly providerId = "copilot-web";

	protected readonly config: ApiClientConfig = {
		// Copilot moved off copilot.microsoft.com: the legacy host now
		// client-side redirects into the redesigned app hosted on copilot.com
		// (routes: /home, /code, /chat, /autopilot). Matching the old host left
		// the startup tab unmatched, so every call opened another tab.
		hostKey: "copilot.com",
		startUrl: "https://copilot.com/",
		cookieDomain: ".copilot.com",
		defaultModel: "copilot-auto",
		// New Copilot model picker: Auto / Quick response / Think deeper.
		models: [
			{ id: "copilot-auto", name: "Copilot Auto" },
			{ id: "copilot-quick", name: "Copilot Quick Response" },
			{ id: "copilot-think-deeper", name: "Copilot Think Deeper" },
		],
	};

	lastConversationId: string | undefined;

	/** Serialises DOM sends: one page, one composer, one global model picker. */
	private sendQueue: Promise<void> = Promise.resolve();

	protected getCookies() {
		return parseCookieHeader(this.auth.cookie, this.config.cookieDomain);
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		try {
			const page = await this.getPage();
			const result = await page.evaluate(() => {
				const url = location.href;
				// The redesigned Copilot lives on copilot.com; signed-out visitors
				// are bounced through /login to the Microsoft account sign-in hosts.
				const onLoginPage =
					url.includes("login.microsoftonline.com") ||
					url.includes("login.live.com") ||
					url.includes("/login");
				const elements = document.querySelectorAll("button, a, [role='button']");
				const hasSignIn = Array.from(elements).some((el) => {
					const text = el.textContent?.trim().toLowerCase() ?? "";
					return text === "sign in" || text === "log in" || text.includes("sign in with");
				});
				const hasChatInput =
					!!document.querySelector('[contenteditable="true"]') ||
					!!document.querySelector("textarea[placeholder]") ||
					!!document.querySelector('div[role="textbox"]') ||
					!!document.querySelector("textarea");
				return { onLoginPage, hasSignIn, hasChatInput };
			});
			if (result.onLoginPage || result.hasSignIn) {
				return { valid: false, reason: "Copilot sign-in page detected — session expired" };
			}
			if (result.hasChatInput) return { valid: true };
			return { valid: false, reason: "Copilot chat input not found" };
		} catch (err) {
			return { valid: false, reason: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * Not used directly — Copilot overrides `sendMessage` because its
	 * pull-based streaming and DOM fallback logic requires custom flow.
	 */
	protected async callApi(_page: Page, _params: NormalizedSendParams): Promise<EvalResult> {
		throw new Error("Copilot uses custom sendMessage; callApi is not reachable.");
	}

	/**
	 * Full custom sendMessage for Copilot:
	 * - Switches the composer's model picker to the requested mode
	 * - Uses DOM-based interaction since Copilot doesn't have a simple REST API
	 */
	override async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		// There is a single page/composer and the model picker is global UI state,
		// so requests must not interleave. Chain them.
		const run = this.sendQueue.then(() => this.sendWithChatMode(params));
		this.sendQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Select the picker mode requested by `params.model`, send the message, then
	 * restore the user's previous picker selection.
	 */
	private async sendWithChatMode(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const wanted = resolveCopilotModeLabel(params.model);
		let previous: string | null = null;

		if (wanted) {
			const current = await this.readChatMode(page);
			if (current === null) {
				console.warn(
					"[Copilot] model picker (#gptModeSwitcher) not found — sending with the browser's current mode",
				);
			} else if (current !== wanted) {
				await this.selectChatMode(page, wanted);
				previous = current;
			}
		}

		try {
			return await this.chatCompletionsViaDOM({
				message: params.message,
				signal: params.signal,
			});
		} finally {
			if (previous) {
				try {
					await this.selectChatMode(page, previous);
				} catch (err) {
					console.warn(
						`[Copilot] could not restore the model picker to "${previous}": ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
		}
	}

	/** Current picker label ("Auto", "Quick response", …), or null when absent. */
	private async readChatMode(page: Page): Promise<string | null> {
		return page.evaluate(() => {
			const text = document
				.querySelector("#gptModeSwitcher")
				?.textContent?.replace(/\s+/g, " ")
				.trim();
			return text ? text : null;
		});
	}

	/**
	 * Switch the composer's model picker to `label`.
	 *
	 * The picker is a Fluent menu button (`#gptModeSwitcher`) whose items are
	 * supplied by the server, so the lookup is scoped to the picker's own
	 * `fui-MenuList` menu and compares only the leading text of each item. A
	 * global `[role="menuitem"]` search would match unrelated sidebar entries —
	 * "Automations" also starts with "Auto".
	 */
	private async selectChatMode(page: Page, label: string): Promise<void> {
		await page.evaluate(() => {
			(document.querySelector("#gptModeSwitcher") as HTMLElement | null)?.click();
		});

		await page
			.waitForFunction(
				() => !!document.querySelector('div.fui-MenuList[role="menu"] [role="menuitem"]'),
				undefined,
				{ timeout: 5000 },
			)
			.catch(() => {});

		const result = await page.evaluate((wanted: string) => {
			const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
			const target = norm(wanted);
			const menu = document.querySelector('div.fui-MenuList[role="menu"]');
			if (!menu) return { ok: false, options: [] as string[] };
			const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
			const options = items.map((el) =>
				(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
			);
			const match = items.find((el) => norm(el.textContent ?? "").startsWith(target));
			if (!match) return { ok: false, options };
			(match as HTMLElement).click();
			return { ok: true, options };
		}, label);

		if (!result.ok) {
			// Leave the UI as we found it: only toggle when the menu is still open.
			await page.evaluate(() => {
				if (document.querySelector('div.fui-MenuList[role="menu"]')) {
					(document.querySelector("#gptModeSwitcher") as HTMLElement | null)?.click();
				}
			});
			throw new Error(
				`Copilot: model picker has no "${label}" option (available: ${
					result.options.join(" | ") || "none"
				}).`,
			);
		}

		// Confirm the switch took effect before the message is sent.
		try {
			await page.waitForFunction(
				(wanted: string) =>
					document.querySelector("#gptModeSwitcher")?.textContent?.replace(/\s+/g, " ").trim() ===
					wanted,
				label,
				{ timeout: 5000 },
			);
		} catch {
			throw new Error(`Copilot: model picker did not switch to "${label}".`);
		}

		// Fluent UI restores focus to the trigger button once its menu has closed,
		// so let that settle before the composer is clicked — otherwise focus is
		// yanked back mid-submit and the message never sends.
		await page
			.waitForFunction(() => !document.querySelector('div.fui-MenuList[role="menu"]'), undefined, {
				timeout: 3000,
			})
			.catch(() => {});
		await delay(400);
	}

	/**
	 * Submit the composer and verify the turn actually started.
	 *
	 * Enter alone is not reliable: the mode picker steals focus back to its
	 * trigger button, and a swallowed Enter leaves the prompt sitting in the
	 * composer while the gateway polls for a reply that can never arrive. The
	 * explicit Send button is tried first, then Enter, and success is confirmed
	 * by an empty composer or the prompt appearing in the transcript.
	 */
	private async submitMessage(page: Page, input: ElementHandle, prompt: string): Promise<void> {
		const clicked = await page
			.evaluate(() => {
				const btn = document.querySelector<HTMLButtonElement>(
					'button[aria-label="Send"], button[data-testid="send-button"], button[aria-label*="Send"]',
				);
				if (!btn || btn.disabled) return false;
				btn.click();
				return true;
			})
			.catch(() => false);

		if (clicked && (await this.waitForSubmit(page, input, prompt))) return;

		// Fallback: put focus back on the composer and use Enter.
		await input.focus().catch(() => {});
		await delay(200);
		await input.press("Enter").catch(() => {});
		if (await this.waitForSubmit(page, input, prompt)) return;

		const composerText = await input
			.evaluate((el) => (el.textContent ?? "").replace(/[\u200B-\u200D\uFEFF]/g, " ").trim())
			.catch((err) => `<unavailable: ${err instanceof Error ? err.message : String(err)}>`);
		const inTranscript = await this.readTurnState(page, prompt)
			.then((turn) => turn.submitted)
			.catch(() => false);
		throw new Error(
			`Copilot: the message could not be submitted to the composer ` +
				`(send button clicked: ${clicked}; prompt visible in transcript: ${inTranscript}; ` +
				`composer text: "${composerText.slice(0, 60)}"). ` +
				"Open copilot.com and check that the chat input is visible.",
		);
	}

	/** Success = composer emptied, or the prompt rendered as a user bubble. */
	private async waitForSubmit(
		page: Page,
		input: ElementHandle,
		prompt: string,
		timeoutMs = 6000,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const cleared = await input
					.evaluate(
						(el) => (el.textContent ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim() === "",
					)
					.catch(() => false);
				if (cleared) return true;
				if ((await this.readTurnState(page, prompt)).submitted) return true;
			} catch {
				// Submitting the first message of a conversation reloads the page to
				// /chat/conversation/<id> — keep polling through the navigation.
			}
			await delay(250);
		}
		return false;
	}

	private async chatCompletionsViaDOM(params: {
		message: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		let inputHandle: ElementHandle | null = null;
		for (const sel of COPILOT_INPUT_SELECTORS) {
			inputHandle = await page.$(sel);
			if (inputHandle) break;
		}
		if (!inputHandle) throw new Error("Copilot: could not find chat input");

		await inputHandle.click();
		await delay(300);
		await pasteText(page, params.message, inputHandle);
		await delay(300);
		await this.submitMessage(page, inputHandle, params.message);
		const maxWaitMs = 120000;
		const pollIntervalMs = 2000;
		const requiredStableReads = 3;
		let lastText = "";
		let stableCount = 0;
		for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
			if (params.signal?.aborted) throw new Error("Copilot request aborted");
			await delay(pollIntervalMs);
			// Anchored on THIS prompt: "the newest reply" is unsafe, because the
			// first send navigates to /chat/conversation/<id> and re-renders the
			// transcript — which can make an earlier answer look like this turn's.
			const state = await this.readTurnState(page, params.message);

			if (!state.submitted || !state.replyText) continue;
			if (COPILOT_PLACEHOLDER_RE.test(state.replyText)) continue;

			if (state.replyText === lastText) {
				stableCount++;
				// A visible "Stop" button means Copilot is still generating — insist
				// on extra stable reads before accepting the text.
				const settled = !state.streaming || stableCount >= requiredStableReads + 2;
				if (stableCount >= requiredStableReads && settled) break;
			} else {
				lastText = state.replyText;
				stableCount = 0;
			}
		}
		if (!lastText)
			throw new Error(
				"Copilot: no reply detected. Open copilot.com, sign in, and ensure the chat input is visible.",
			);
		lastText = lastText
			.replace(/^Copilot said:?\s*/i, "")
			.replace(/\s*Edit in a page\s*$/i, "")
			.replace(/\s*Copilot is an AI[\s\S]*?Privacy Statement\./, "");
		const ndjsonLine = `${JSON.stringify({ contentDelta: lastText })}\n`;
		return textToStream(ndjsonLine);
	}

	/**
	 * Locate THIS turn's message: whether the prompt made it into the transcript
	 * and, if so, the assistant reply rendered beside it.
	 *
	 * Matching on the prompt text (instead of "the newest reply") is what keeps
	 * the answer correct: sending the first message navigates the page to
	 * /chat/conversation/<id>, which re-renders the transcript and can make an
	 * earlier answer look like this turn's reply.
	 */
	private async readTurnState(
		page: Page,
		prompt: string,
	): Promise<{ submitted: boolean; replyText: string; streaming: boolean }> {
		return page.evaluate(
			({ prompt, selectors }) => {
				const clean = (t: string | null | undefined) =>
					(t ?? "")
						.replace(/[\u200B-\u200D\uFEFF]/g, "")
						.replace(/\s+/g, " ")
						.trim();
				const needle = clean(prompt).toLowerCase().slice(-60);
				const messages = Array.from(
					document.querySelectorAll('[data-testid="m365-chat-llm-web-ui-chat-message"]'),
				);
				let submitted = false;
				let replyText = "";
				if (needle) {
					for (let i = messages.length - 1; i >= 0; i--) {
						const node = messages[i];
						if (!node) continue;
						const question = node.querySelector('[data-testid="chatQuestion"]');
						if (!question || !clean(question.textContent).toLowerCase().includes(needle)) continue;
						submitted = true;
						for (const sel of selectors) {
							const text = clean(node.querySelector(sel)?.textContent ?? "");
							if (text) {
								replyText = text;
								break;
							}
						}
						break;
					}
				}
				const stopBtn = document.querySelector(
					'[data-testid="stop-button"], [data-testid*="stop-generating"], button[aria-label*="Stop"]',
				);
				const streaming = !!stopBtn && (stopBtn as HTMLElement).getBoundingClientRect().width > 0;
				return { submitted, replyText, streaming };
			},
			{ prompt, selectors: COPILOT_REPLY_SELECTORS },
		);
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseCopilotStream(body, onDelta);
	}
}
