import { describe, expect, test } from "bun:test";
import { BrowserManager } from "../src/browser/manager.ts";

describe("BrowserManager.shutdown", () => {
	test("resolves even when browser.close() never settles", async () => {
		const manager = BrowserManager.getInstance();
		const internal = manager as unknown as {
			browser: unknown;
			context: unknown;
		};
		let closeCalled = false;
		internal.browser = {
			removeAllListeners: () => {},
			close: () => {
				closeCalled = true;
				// Simulates a CDP-attached Chrome that never acknowledges.
				return new Promise<void>(() => {});
			},
		};
		internal.context = { fake: true };

		const started = Date.now();
		await manager.shutdown();
		const elapsed = Date.now() - started;

		expect(closeCalled).toBe(true);
		expect(elapsed).toBeLessThan(5000);
		expect(internal.browser).toBeNull();
		expect(internal.context).toBeNull();
	});

	test("is a no-op when there is no browser", async () => {
		const manager = BrowserManager.getInstance();
		const internal = manager as unknown as { browser: unknown };
		internal.browser = null;

		await manager.shutdown();
		expect(internal.browser).toBeNull();
	});
});
