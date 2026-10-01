import { describe, expect, test } from "bun:test";
import type { BrowserContext, Page } from "playwright-core";
import {
	COPILOT_REPLY_SELECTORS,
	CopilotWebClient,
	resolveCopilotModeLabel,
} from "../src/providers/copilot/client.ts";
import { reuseExistingTab } from "../src/providers/shared/tab-reuse.ts";

interface FakeTab {
	page: Page;
	closed: () => boolean;
}

function fakeTab(url: string): FakeTab {
	let isClosed = false;
	const page = {
		url: () => url,
		async bringToFront() {},
		async close() {
			isClosed = true;
		},
	} as unknown as Page;
	return { page, closed: () => isClosed };
}

function fakeContext(pages: Page[]): BrowserContext {
	return { pages: () => pages } as unknown as BrowserContext;
}

// Copilot moved from copilot.microsoft.com (legacy host, now client-side
// redirects into the new app) to copilot.com. These tests pin the domain list
// the provider relies on so a stray tab no longer spawns duplicates.
describe("copilot tab reuse", () => {
	test("reuses the copilot.com tab and closes legacy duplicates", async () => {
		const legacy = fakeTab("https://copilot.microsoft.com/");
		const current = fakeTab("https://copilot.com/home");
		const other = fakeTab("https://chatgpt.com/");

		const page = await reuseExistingTab(fakeContext([legacy.page, current.page, other.page]), [
			"copilot.com",
			"copilot.microsoft.com",
		]);

		expect(page).toBe(current.page);
		expect(legacy.closed()).toBe(true);
		expect(other.closed()).toBe(false);
	});

	test("matches the legacy host when that tab has not redirected yet", async () => {
		const legacy = fakeTab("https://copilot.microsoft.com/chat");
		const page = await reuseExistingTab(fakeContext([legacy.page]), [
			"copilot.com",
			"copilot.microsoft.com",
		]);
		expect(page).toBe(legacy.page);
	});

	test("does not match the legacy host against copilot.com alone", async () => {
		const legacy = fakeTab("https://copilot.microsoft.com/");
		const page = await reuseExistingTab(fakeContext([legacy.page]), ["copilot.com"]);
		expect(page).toBeNull();
	});

	test("returns null when no Copilot tab is open", async () => {
		const other = fakeTab("https://gemini.google.com/app");
		const page = await reuseExistingTab(fakeContext([other.page]), [
			"copilot.com",
			"copilot.microsoft.com",
		]);
		expect(page).toBeNull();
		expect(other.closed()).toBe(false);
	});
});

describe("CopilotWebClient", () => {
	test("exposes the redesigned picker options", () => {
		const client = new CopilotWebClient({ cookie: "", userAgent: "" });
		expect(client.providerId).toBe("copilot-web");
		expect(client.listModels().map((m) => m.id)).toEqual([
			"copilot-auto",
			"copilot-quick",
			"copilot-think-deeper",
		]);
	});

	// Regression: the old scraper matched `[class*="message"]`, whose last match on
	// copilot.com is `fai-UserMessage__message` — the user's own bubble. The
	// gateway then returned the prompt as the answer. Reply containers must stay
	// scoped to the assistant-only data-testids.
	test("reply selectors only target assistant containers", () => {
		expect(COPILOT_REPLY_SELECTORS.length).toBeGreaterThan(0);
		for (const sel of COPILOT_REPLY_SELECTORS) {
			expect(sel.startsWith('[data-testid="')).toBe(true);
			expect(sel).not.toContain("class*");
		}
		expect(COPILOT_REPLY_SELECTORS).not.toContain('[data-testid="chatQuestion"]');
	});
});

// Each TFG model id must drive a distinct option in the composer's picker,
// otherwise all three ids behave identically (which was the original bug).
describe("resolveCopilotModeLabel", () => {
	test("maps the picker options", () => {
		expect(resolveCopilotModeLabel("copilot-auto")).toBe("Auto");
		expect(resolveCopilotModeLabel("copilot-quick")).toBe("Quick response");
		expect(resolveCopilotModeLabel("copilot-think-deeper")).toBe("Think deeper");
	});

	test("normalises casing and separators", () => {
		expect(resolveCopilotModeLabel("COPILOT_THINK_DEEPER")).toBe("Think deeper");
		expect(resolveCopilotModeLabel("copilot quick")).toBe("Quick response");
		expect(resolveCopilotModeLabel("copilot-web/copilot-auto")).toBe("Auto");
	});

	test("accepts short aliases", () => {
		expect(resolveCopilotModeLabel("quick")).toBe("Quick response");
		expect(resolveCopilotModeLabel("think")).toBe("Think deeper");
		expect(resolveCopilotModeLabel("fast")).toBe("Quick response");
	});

	test("returns null for unknown ids so the picker is left alone", () => {
		expect(resolveCopilotModeLabel("copilot-research")).toBeNull();
		expect(resolveCopilotModeLabel("")).toBeNull();
		expect(resolveCopilotModeLabel(undefined)).toBeNull();
		expect(resolveCopilotModeLabel(null)).toBeNull();
	});

	test("every registered copilot model id resolves to a picker option", () => {
		const client = new CopilotWebClient({ cookie: "", userAgent: "" });
		for (const model of client.listModels()) {
			expect(resolveCopilotModeLabel(model.id)).not.toBeNull();
		}
	});
});
