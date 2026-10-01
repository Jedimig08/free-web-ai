import { chromium } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../../browser/cdp-helpers.ts";
import { reuseExistingTab } from "../shared/tab-reuse.ts";

export interface CopilotWebAuth {
	cookie: string;
	userAgent: string;
}

export async function loginCopilotWeb(params: {
	onProgress: (msg: string) => void;
	openUrl: (url: string) => Promise<boolean>;
}): Promise<CopilotWebAuth> {
	const onProgress = params.onProgress;
	const cdpUrl = getDefaultCdpUrl();
	onProgress(`Connecting to Chrome at ${cdpUrl}...`);

	let wsUrl: string | null = null;
	for (let i = 0; i < 10; i++) {
		wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
		if (wsUrl) break;
		await new Promise((r) => setTimeout(r, 500));
	}
	if (!wsUrl) {
		throw new Error(
			`Failed to connect to Chrome at ${cdpUrl}. Make sure Chrome is running in debug mode.`,
		);
	}

	onProgress("Connecting to browser...");
	const browser = await chromium.connectOverCDP(wsUrl, {
		headers: getHeadersWithAuth(wsUrl),
	});
	const context = browser.contexts()[0];
	if (!context) throw new Error("No browser context available");

	// Reuse the Copilot tab opened at Chrome startup (closing any leftover
	// duplicate tabs) instead of grabbing pages()[0] — which hijacks whatever
	// tab happens to be first and creates a second, duplicate tab.
	//
	// Both hosts are listed: copilot.microsoft.com is the legacy host, which
	// now client-side redirects into the new copilot.com app. Matching only the
	// legacy host left the startup tab unmatched and spawned duplicates every
	// time this flow ran. reuseExistingTab() also closes legacy duplicates.
	const page =
		(await reuseExistingTab(context, ["copilot.com", "copilot.microsoft.com"])) ??
		(await context.newPage());

	if (!page.url().includes("copilot.com")) {
		params.onProgress("Navigating to Copilot...");
		await page.goto("https://copilot.com/", { waitUntil: "domcontentloaded" });
	}

	const userAgent = await page.evaluate(() => navigator.userAgent);
	onProgress("Please sign in to Copilot in the browser window...");
	onProgress("Waiting for authentication...");

	return new Promise<CopilotWebAuth>((resolve, reject) => {
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) reject(new Error("Login timed out (5 minutes)."));
		}, 300000);

		// Like claude/chatgpt: poll context.cookies() which sees HttpOnly cookies.
		// document.cookie can't see _U/MSPAuth (HttpOnly) — that's why waitForFunction hung.
		//
		// copilot.com is an OIDC-protected ASP.NET Core app, so its session cookie
		// name is not stable. In addition to the Microsoft-account cookies, accept a
		// completed sign-in round-trip: back on copilot.com (not on a Microsoft
		// sign-in host or /login) with the composer rendered.
		const liveUrl = async (): Promise<string> => {
			try {
				return await page.evaluate(() => location.href);
			} catch {
				return page.url();
			}
		};

		const tryResolve = async () => {
			if (resolved) return;
			try {
				const cookies = await context.cookies();
				if (cookies.length === 0) return;

				const hasAccountCookie = cookies.some(
					(c) =>
						c.name === "_U" ||
						c.name === "MSPAuth" ||
						c.name === "MSPProf" ||
						c.name === "__Host-copilot",
				);

				let hasComposer = false;
				if (!hasAccountCookie) {
					const url = await liveUrl();
					const onLoginPage =
						url.includes("login.microsoftonline.com") ||
						url.includes("login.live.com") ||
						url.includes("/login");
					if (!onLoginPage && url.includes("copilot.com")) {
						hasComposer = await page
							.evaluate(
								() =>
									!!document.querySelector('[contenteditable="true"]') ||
									!!document.querySelector("textarea") ||
									!!document.querySelector('div[role="textbox"]'),
							)
							.catch(() => false);
					}
				}

				if (!hasAccountCookie && !hasComposer) return;

				resolved = true;
				clearTimeout(timeout);
				clearInterval(interval);
				const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
				onProgress("Login detected, capturing cookies...");
				onProgress("Authentication captured successfully.");
				resolve({ cookie: cookieString, userAgent });
			} catch (e) {
				console.error(`[Copilot] Failed to fetch cookies: ${e}`);
			}
		};

		page.on("close", () => {
			if (!resolved) {
				clearTimeout(timeout);
				clearInterval(interval);
				reject(new Error("Browser window closed before login was captured."));
			}
		});

		const interval = setInterval(() => {
			void tryResolve();
		}, 1000);

		void tryResolve();
	});
}
