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
 * When several tabs match — e.g. a legacy host that is being migrated to a new
 * domain — the tab matching the FIRST entry of `domains` (the canonical host)
 * wins. Every other matching tab is closed so leftover duplicates (from older
 * buggy versions, Chrome session restore, or a host migration) do not pile up.
 * The surviving tab is brought to the front for the user.
 */
export async function reuseExistingTab(
	context: BrowserContext,
	domains: string[],
): Promise<Page | null> {
	const matches = context.pages().filter((p) => urlMatches(p, domains));
	if (matches.length === 0) return null;

	// Prefer the canonical (first) domain over any legacy aliases.
	const canonicalHost = domains[0];
	const page =
		(canonicalHost ? matches.find((p) => urlMatches(p, [canonicalHost])) : undefined) ??
		matches[0]!;

	for (const p of matches) {
		if (p === page) continue;
		try {
			await p.close();
		} catch {}
	}

	try {
		await page.bringToFront();
	} catch {}

	return page;
}
