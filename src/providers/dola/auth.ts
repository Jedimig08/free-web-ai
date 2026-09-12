import { chromium } from "playwright-core";
import {
	getChromeWebSocketUrl,
	getDefaultCdpUrl,
	getHeadersWithAuth,
} from "../../browser/cdp-helpers.ts";
import { reuseExistingTab } from "../shared/tab-reuse.ts";

export interface DolaWebAuth {
	sessionid: string;
	ttwid?: string;
	userAgent: string;
	cookie?: string;
	s_v_web_id?: string;
	fp?: string;
}

export async function loginDolaWeb(params: {
	onProgress: (msg: string) => void;
	openUrl: (url: string) => Promise<boolean>;
}): Promise<DolaWebAuth> {
	const cdpUrl = getDefaultCdpUrl();
	params.onProgress(`Connecting to Chrome at ${cdpUrl}...`);

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

	params.onProgress("Connecting to browser...");
	const browser = await chromium.connectOverCDP(wsUrl, {
		headers: getHeadersWithAuth(wsUrl),
	});
	const context = browser.contexts()[0];
	if (!context) throw new Error("No browser context available");

	// Reuse the Dola tab opened at Chrome startup (closing any leftover
	// duplicate tabs) instead of grabbing pages()[0] — which hijacks whatever
	// tab happens to be first and creates a second, duplicate tab.
	let page = await reuseExistingTab(context, ["dola.com"]);
	if (!page) {
		page = await context.newPage();
	}

	if (!page.url().includes("dola.com")) {
		await page.goto("https://www.dola.com/chat/");
	}
	const userAgent = await page.evaluate(() => navigator.userAgent);

	params.onProgress("Please login to Dola in the opened browser window...");

	return new Promise<DolaWebAuth>((resolve, reject) => {
		let resolved = false;

		const timeout = setTimeout(() => {
			if (!resolved) reject(new Error("Login timed out (5 minutes)."));
		}, 300000);

		const tryResolve = async () => {
			if (resolved) return;
			try {
				const cookies = await context.cookies(["https://www.dola.com", "https://dola.com"]);
				if (cookies.length === 0) return;

				const sessionidCookie = cookies.find((c) => c.name === "sessionid");
				const ttwidCookie = cookies.find((c) => c.name === "ttwid");

				if (sessionidCookie) {
					resolved = true;
					clearTimeout(timeout);
					const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
					const sVWebIdCookie = cookies.find((c) => c.name === "s_v_web_id");
					const fpCookie = cookies.find((c) => c.name === "fp");
					resolve({
						sessionid: sessionidCookie.value,
						ttwid: ttwidCookie?.value,
						userAgent,
						cookie: cookieString,
						s_v_web_id: sVWebIdCookie?.value,
						fp: fpCookie?.value,
					});
				}
			} catch (e: unknown) {
				console.error(`[Dola] Failed to fetch cookies: ${String(e)}`);
			}
		};

		page.on("request", async (request) => {
			const url = request.url();
			if (url.includes("dola.com")) {
				const headers = request.headers();
				if (headers.cookie?.includes("sessionid")) await tryResolve();
			}
		});

		page.on("response", async (response) => {
			const url = response.url();
			if (url.includes("dola.com") && response.ok()) await tryResolve();
		});

		page.on("close", () => {
			reject(new Error("Browser window closed before login was captured."));
		});

		const checkInterval = setInterval(async () => {
			await tryResolve();
			if (resolved) clearInterval(checkInterval);
		}, 2000);
	});
}
