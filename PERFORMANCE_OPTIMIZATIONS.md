# free-web-ai Performance Optimizations

Comprehensive catalog of ways to reduce resource usage (RAM, CPU, latency, and connection pressure) for this project.  
Scope: researched from the current codebase and deployment behavior (ChatGPT-web gateway over CDP/Chromium).

## Status key
- **Applied (feature branches):** committed on `all-permitions-chatgpt`, `all-permitions-chatgpt-openhands`, `chat-gpt-on-openhands` (not on `origin/main`).
- **Config-only:** achievable now via existing env/config without code changes.
- **Code change:** requires implementation.
- **Ops/infra:** deployment, OS, or process management changes.

---

## 1) Applied optimizations (feature branches)

| Area | Change | Files/notes | Expected impact |
|---|---|---|---|
| Browser tabs | Limit debug Chrome startup to only `https://chatgpt.com` (instead of opening many provider tabs) | `start-chrome-debug.sh` | ~90%+ lower browser RAM/CPU from idle tabs (12→1) |
| Prompt size | Reduce default `DEFAULT_MAX_PROMPT_CHARS` from `60_000` to `8_000` | `src/openai/chat-completions.ts` | ~85% less prompt payload per large request; faster trim/transfer/processing; lower OOM risk. `TFG_MAX_PROMPT_CHARS` can still override. |

> `origin/main` intentionally left unchanged for these defaults/tabs per branch policy.

---

## 2) Config-only tuning (existing knobs)

| Knob | Default | Recommended | Why it helps | Where |
|---|---:|---:|---|---|
| `TFG_MAX_PROMPT_CHARS` | 8000 (feature branches) / 60000 (main) | `4000`–`8000` | Trims earlier; less memory/tokenization/serialization and fewer 413 retries | `src/openai/chat-completions.ts`, `src/providers/shared/prompt-trim.ts` |
| `TFG_REQUEST_TIMEOUT_SEC` | 300 | `60`–`120` | Frees stuck request slots/browser work sooner; reduces long-held resources | `src/config.ts`, `src/server.ts`, `src/openai/chat-completions.ts` |
| `TFG_API_KEY` | empty (auth disabled) | set a secret when exposed | Avoids unauthorized load/abuse (indirect resource protection) | `src/auth.ts`, `src/config.ts` |
| `TFG_CDP_URL` | `http://127.0.0.1:9222` | point to dedicated browser host | Offloads Chromium RAM/CPU from gateway machine | `src/browser/cdp-helpers.ts`, `src/browser/manager.ts` |
| `TFG_PORT` / `TFG_STORE_PATH` | defaults | tune per deploy | Operational hygiene (no direct perf win, but helps isolation) | `src/config.ts`, `src/providers/auth-store.ts` |

**Example (.env / env):**
```bash
TFG_MAX_PROMPT_CHARS=8000
TFG_REQUEST_TIMEOUT_SEC=60
TFG_API_KEY="replace-with-secret"
TFG_CDP_URL="http://127.0.0.1:9222"
```

---

## 3) Prompt & conversation efficiency

| Idea | Effort | Impact | Details |
|---|---:|---:|---|
| Turn-aware trimming (not raw char split) | Med | Med–High | `trimPromptToFit` keeps head+tail by chars and can cut mid-turn; preserve full recent turns + system/tool preamble for better quality per char |
| Summarize/compact old history | Med–High | High (long chats) | Replace stale turns with a short rolling summary to cap growth while retaining intent |
| Deduplicate static tool prompt | Med | Med | `src/tool-calling/prompt.ts` injects tool JSON/instructions each request; cache or minimize when toolset unchanged |
| Cap turns per upstream conversation | Med | Med | Reset/rotate ChatGPT `conversationId` strategically to avoid server-side context bloat (already resets on trim/413 in places; can be policy-driven) |
| Reject/short-circuit oversized bodies early | Low–Med | Med | Fail fast before building/parsing huge prompts to save CPU/memory |
| Token-aware limits (if available) | High | Med | Char limits are coarse; token-based budgeting would be more precise (needs tokenizer or heuristics) |

**Relevant code:** `src/openai/chat-completions.ts`, `src/providers/shared/prompt-trim.ts`, `src/providers/chatgpt/client.ts`, `src/tool-calling/prompt.ts`, `src/tool-calling/converter.ts`.

---

## 4) Browser/Chromium resource control

| Idea | Effort | Impact | Details |
|---|---:|---:|---|
| **Idle browser shutdown** | Med | High | `BrowserManager` (`src/browser/manager.ts`) keeps context forever; add idle timer (e.g. `TFG_BROWSER_IDLE_TIMEOUT`) to `shutdown()` after inactivity and reconnect on demand |
| **On-demand browser start** | Med | High (bursty use) | Don’t keep Chrome warm 24/7; start on first request, stop after idle window |
| **Periodic restart/rotation** | Low–Med | Med | Cron/systemd timer to restart gateway+Chrome to clear cache/profile bloat, leaked DOM, long-lived renderer growth |
| **Headless/lean flags** | Low–Med | Med | `--headless=new`, `--disable-gpu`, `--mute-audio`, `--disable-extensions`, `--disable-software-rasterizer`, consider `--renderer-process-limit=1` (validate ChatGPT compatibility) |
| **Block heavy resources (CDP)** | Med | Med–High | Use `Network.setBlockedURLs` / Fetch interception to block images/fonts/media/trackers on ChatGPT pages while allowing required `oaistatic`/API endpoints; lowers CPU/RAM/bandwidth |
| **Ephemeral profile on tmpfs** | Med | Med | Put `--user-data-dir` on tmpfs for speed and automatic cleanup; or rotate profiles to prevent unbounded disk/RAM-backed growth |
| **Limit open pages/tabs** | Low–Med | Med | `BrowserManager.getPage`/reuse logic can accumulate pages; enforce max pages and close stale ones |
| **Reduce startup waits where safe** | Low | Low–Med | `start-chrome-debug.sh`/`src/cli/chrome.ts` wait loops (CDP probe, fixed sleeps) are conservative; tune carefully to avoid flakiness |
| **Resource caps** | Low (ops) | High (stability) | cgroups/systemd/Docker limits (MemoryMax/CPUQuota/pids) to prevent host exhaustion; Chrome `--js-flags=--max-old-space-size=...` (tune) |

**Relevant code:** `src/browser/manager.ts`, `src/browser/cdp-helpers.ts`, `src/browser/dom-input.ts`, `src/cli/chrome.ts`, `start-chrome-debug.sh`, `browser/*`.

---

## 5) Streaming, parsing, and request-path efficiency

| Idea | Effort | Impact | Details |
|---|---:|---:|---|
| **Incremental streaming from browser** | High | High | `ChatGPTWebClient.callApi` (`src/providers/chatgpt/client.ts`) accumulates full SSE in `page.evaluate` (`reader.read()` → `fullText`) then returns once; doubles buffering and hurts TTFB. Stream chunks out via CDP bindings/callbacks or alternate transport |
| **Avoid extra copies in SSE pipeline** | Med | Med | Multiple encode/decode/stringify steps across `src/openai/sse.ts`, `src/openai/chat-completions.ts`, `src/providers/chatgpt/stream.ts`; minimize allocations on hot path |
| **Simplify/focus stream parser** | Med | Low–Med | `src/providers/chatgpt/stream.ts` handles snapshots/patches/thinking tags; smaller prompts/responses reduce cost, but parser work scales with output |
| **Reduce DOM polling delays** | Med | Low–Med | `base-dom-client` polling (default ~2s) and fixed `waitForTimeout` calls (`dom-input.ts`, client/auth) add latency; optimize only with careful testing against ChatGPT UI timing |
| **Bound in-flight work** | Med | Med | `Bun.serve` uses `idleTimeout: 0` (`src/server.ts`); route timeout is Promise.race. Add explicit queue/concurrency=1 per session to avoid contention and memory spikes |

**Relevant code:** `src/server.ts`, `src/openai/chat-completions.ts`, `src/providers/chatgpt/client.ts`, `src/providers/chatgpt/stream.ts`, `src/providers/factory/*`.

---

## 6) Operational / infrastructure strategies

| Idea | Effort | Impact | Details |
|---|---:|---:|---|
| Run browser on a separate host/container | Med | High | Keep gateway lightweight; isolate Chromium memory/CPU via `TFG_CDP_URL` (e.g. browserless/minimal Chrome image with limits) |
| systemd hardening | Low | Med–High | `MemoryMax`, `MemoryHigh`, `CPUQuota`, `TasksMax`, `Restart=on-failure` for gateway and Chrome units |
| zram/swap tuning (small hosts) | Low | Med (stability) | Absorb spikes; not a substitute for fixing leaks/bloat |
| Compiled binary | Low | Low | `bun run build` (single executable) can reduce runtime overhead/startup vs interpreted dev runs |
| Reverse proxy limits | Low | Med | Rate limiting/body size/timeouts at proxy to shed abusive or oversized traffic early |
| Network/resource blocking at edge | Low–Med | Med | If using remote browser infra, block unnecessary domains/assets consistently |

---

## 7) Observability to guide tuning

| Metric | Why |
|---|---|
| Bun process RSS/heap, event-loop lag | Detect leaks, GC pressure, saturation |
| Chromium RSS, renderer count, tab count, profile dir size | Dominant resource consumer; catches tab/profile growth |
| Request latency (p50/p95), TTFB, total time | Quantify impact of streaming/trim/timeout changes |
| 413 rate, trim frequency, retry count | Tune `TFG_MAX_PROMPT_CHARS` and conversation strategy |
| Timeout/error/session-expired/reconnect rates | Find flakiness that causes wasted work/retries |
| `/health` (`browser`, `sessions`, `status`) | Already exposed in `src/server.ts`; monitor continuously |

---

## 8) Suggested rollout order (highest leverage first)

1. **Keep applied fixes:** 1-tab Chrome + 8K prompt default (done on feature branches).
2. **Config:** set `TFG_REQUEST_TIMEOUT_SEC=60` and keep `TFG_MAX_PROMPT_CHARS` at 4K–8K for your workload.
3. **Browser lifecycle:** add idle shutdown/on-demand start + periodic restart (big win for always-on hosts).
4. **Chrome footprint:** headless + block nonessential resources + tmpfs/rotated profile (validate ChatGPT behavior).
5. **Request path:** implement incremental streaming and per-session concurrency control (big engineering effort, big payoff).
6. **Ops:** isolate browser, enforce cgroup/systemd limits, add monitoring/alerts.

---

## 9) Quick reference (current defaults & locations)

- Prompt trim default: `src/openai/chat-completions.ts` (`DEFAULT_MAX_PROMPT_CHARS`), logic in `src/providers/shared/prompt-trim.ts`.
- Timeouts/config: `src/config.ts`, `TFG_REQUEST_TIMEOUT_SEC`, route timeout in `src/openai/chat-completions.ts`, send timeout in `src/providers/chatgpt/client.ts`.
- Server idle: `src/server.ts` (`Bun.serve(..., idleTimeout: 0)`).
- Browser lifecycle: `src/browser/manager.ts`; Chrome startup: `src/cli/chrome.ts`, `start-chrome-debug.sh`.
- Health: `GET /health` in `src/server.ts`.

*This document is intended as a living checklist; validate each change against ChatGPT web UI behavior and session stability.*
