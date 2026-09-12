import type { BrowserContext, Page } from "playwright-core";

function urlMatches(page: Page, domains: string[]): boolean {
	try {
		const url = page.url();
		return domains.some((d) => url.includes(d));
	} catch {
		// A page that just navigated may transiently throw; treat as no-match
		// so the caller falls back to creating a fresh tab.
		return false;
	}
}

/**
 * Find an existing tab for `domains`, or return null when none exists.
 *
 * Reuses the tab Chrome opened at startup for this provider instead of
 * grabbing `pages()[0]` (which hijacks whatever tab happens to be first and
 * leaves a duplicate login tab behind).
 *
 * Also closes leftover duplicate tabs for the same domain (e.g. created by
 * older buggy versions or Chrome session restore), keeping only the first
 * matching tab, and brings it to the front for the user.
 */
export async function reuseExistingTab(
	context: BrowserContext,
	domains: string[],
): Promise<Page | null> {
	let page: Page | null = null;
	for (const p of context.pages()) {
		if (!urlMatches(p, domains)) continue;
		if (!page) {
			page = p;
			try {
				await p.bringToFront();
			} catch {}
		} else {
			try {
				await p.close();
			} catch {}
		}
	}
	return page;
}
