### ✨ What's New

- **Copilot moved to the new `copilot.com` app** — the legacy `copilot.microsoft.com` host now client-side redirects, so the provider, the login flow and the Chrome startup tab were all pointed at `copilot.com` (`/home` → `/chat/conversation/<id>`)
- **Copilot model ids now drive the real model picker** on `copilot.com`, and each request restores your previous selection when it finishes:
  - `copilot-auto` → **Auto**
  - `copilot-quick` → **Quick response**
  - `copilot-think-deeper` → **Think deeper**
- Copilot sends are serialised (one composer, one global picker) so concurrent requests no longer interleave

### 🐛 Fixes

- **Copilot no longer hands your prompt back as the answer** — replies are scraped from assistant-only containers (`data-testid="markdown-reply"` / `copilot-message-reply-div`) instead of the old `[class*="message"]` selector, which matched `fai-UserMessage__message` (your own bubble)
- **Copilot answers are anchored to the current turn** — matched on the prompt text in the transcript instead of "the newest reply", which misfired on the first message because sending navigates to `/chat/conversation/<id>` and re-renders the transcript
- **Copilot submits reliably** — explicit Send button first, then Enter, confirmed by an emptied composer or the prompt appearing in the transcript (the mode picker used to steal focus and swallow Enter)
- **No more duplicate provider tabs** — `reuseExistingTab` prefers the canonical (first-listed) host over legacy aliases and closes the rest; Copilot reuses the startup tab instead of grabbing `pages()[0]`
- Copilot login now detects a completed sign-in on the OIDC-protected app (back on `copilot.com` with the composer rendered), not just Microsoft-account cookie names

### ⚠️ Breaking Changes

- Copilot model ids changed with the site redesign. Use `copilot-auto`, `copilot-quick`, `copilot-think-deeper`; the old `copilot-smart`, `copilot-study` and `copilot-search` ids were removed.

### 🔧 Other Changes

- README (English + 简体中文) updated for the Copilot domain and model changes
- New tests: Copilot tab reuse, assistant-only reply selectors and model-id → picker resolution
