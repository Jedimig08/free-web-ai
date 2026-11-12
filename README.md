# free-web-ai

ChatGPT-only, OpenAI-compatible gateway for OpenCode.

The gateway logs into a ChatGPT web session through Chromium and exposes
OpenAI-compatible endpoints (`/v1/models`, `/v1/chat/completions`). ChatGPT is
prompted to emit ordinary fenced `bash` blocks; the gateway converts them into
real tool calls for OpenCode's built-in Bash tool and passes the execution
results back to ChatGPT on the next turn. Nothing is executed inside the
gateway.

## What it provides

- A ChatGPT provider backed by a browser session (no OpenAI API key required)
- OpenAI-compatible `/v1/models` and `/v1/chat/completions` (streaming and non-streaming)
- Bash-block to tool-call conversion for OpenCode
- An OpenHands Agent Canvas control plane, preconfigured to use the gateway
- OpenCode registered inside OpenHands as an ACP coding agent
- An OpenCode web UI and, on headless servers, a noVNC login page
- An optional local frontpage linking the web UIs

## Requirements

- Ubuntu or Debian
- A normal user with sudo (Chromium will not run as root)
- Network access to install Bun, Node.js, uv, OpenCode, OpenHands and Chromium

## Install

The branch ships a one-command installer that sets up Bun, Node.js 24, uv,
OpenCode V2, OpenHands Agent Canvas, Chromium, the gateway, the OpenCode web UI
and, in headless mode, the noVNC login page. OpenHands is configured as the
control plane, with the gateway as its LLM provider and OpenCode available as an
ACP coding agent. It clones the branch to `~/free-web-ai`, so no checkout is
needed first.

On a fresh machine:

```bash
curl -fsSL https://raw.githubusercontent.com/Jedimig08/free-web-ai/all-permitions-chatgpt/scripts/install-ubuntu.sh -o install-ubuntu.sh
bash install-ubuntu.sh
```

Add `--frontpage` (or any option below) when running it:

```bash
bash install-ubuntu.sh --frontpage
```

If you already have a checkout:

```bash
cd ~/free-web-ai
./scripts/install-ubuntu.sh
```

Common options:

| Option | Meaning |
| --- | --- |
| `--no-login` | Skip the interactive ChatGPT browser login |
| `--no-service` | Do not install or enable systemd user services |
| `--headless` | Force a virtual display and noVNC login page |
| `--frontpage` | Install and start the optional frontpage |
| `--frontpage-port PORT` | Frontpage port (default: `8080`) |
| `--no-openhands` | Skip Node.js, uv and OpenHands Agent Canvas |
| `--openhands-port PORT` | OpenHands port (default: `8000`) |
| `--reconfigure-openhands` | Recreate the OpenHands LLM and ACP profiles |

Relevant environment variables: `OPENCODE_WEB_PORT` (default `4096`),
`FREE_WEB_AI_NOVNC_PORT` (default `6080`), `TFG_PORT` (default `3456`),
`FREE_WEB_AI_FRONTPAGE_PORT` (default `8080`),
`FREE_WEB_AI_OPENHANDS_PORT` (default `8000`),
`FREE_WEB_AI_OPENHANDS=0` to skip OpenHands, and
`FREE_WEB_AI_OPENHANDS_RECONFIGURE=1` to recreate its profiles.

After a successful install:

| Service | URL |
| --- | --- |
| OpenHands Agent Canvas | `http://<server>:8000` |
| OpenCode web UI | `http://<server>:4096` |
| noVNC login page | `http://<server>:6080/vnc.html?autoconnect=1&resize=scale` |
| Gateway API | `http://<server>:3456/v1` |
| Frontpage (optional) | `http://<server>:8080` |

## OpenHands control plane

OpenHands Agent Canvas runs as `openhands-canvas.service` on port `8000`,
listens on all interfaces and requires its session API key for access. Find it
in `~/.token-free-gateway/openhands.env` (the `LOCAL_BACKEND_API_KEY` value);
the same key is mirrored to `~/.openhands/agent-canvas/api-key.txt`. Paste it
when the OpenHands UI asks for it, or send it as `X-Session-API-Key` when using
the API.

The first launch downloads the pinned agent server through `uvx`, so it can take
a minute. The installer creates two profiles:

- `free-web-ai` (LLM): `openai/chatgpt-auto` via
  `http://127.0.0.1:<TFG_PORT>/v1` (default `3456`), using the gateway key.
  This is the active LLM profile and backs the default OpenHands agent.
- `opencode` (agent): OpenCode over ACP, launched with the installed `opencode`
  binary and `acp`. Select it in **Settings > Agent** when you want OpenCode's
  coding workflow. It uses OpenCode's configured default model
  (`free-web-ai/chatgpt-auto`).

OpenHands is the central control plane; OpenCode remains available both through
its own web UI and as an OpenHands agent. Manage the service with:

```bash
systemctl --user status openhands-canvas.service
systemctl --user restart openhands-canvas.service
```

## Optional frontpage

The frontpage is a standalone file in the repository
(`frontpage/index.html`), not embedded in the installer. It links the web UIs
running on the machine (OpenHands, OpenCode, noVNC and the gateway) and shows
their reachability. It is installed only when requested:

```bash
./scripts/install-ubuntu.sh --frontpage

# or opt in via the environment and use a custom port
FREE_WEB_AI_FRONTPAGE=1 ./scripts/install-ubuntu.sh --frontpage-port 8080
```

The installer copies the page to `~/.token-free-gateway/frontpage/` and writes
`frontpage.json` with the actual service ports, so custom ports are reflected
automatically. It is served by the `pi3b-frontpage.service` systemd user unit,
or by a background `python3 -m http.server` when systemd user services are not
available.

Manage it with:

```bash
systemctl --user status pi3b-frontpage.service
systemctl --user restart pi3b-frontpage.service
```

## Usage

1. Open OpenHands at `http://<server>:8000`, paste the API key from
   `~/.token-free-gateway/openhands.env`, then choose **Settings > Agent** to
   use the default OpenHands agent or the `opencode` ACP profile.
2. Open the OpenCode web UI at `http://<server>:4096` and log in with username
   `opencode`; the password is in `~/.config/opencode/web.env`.
3. Select the model `free-web-ai/chatgpt-auto`.
4. Point any OpenAI-compatible client at `http://<server>:3456/v1`, using the
   Bearer key from `~/.token-free-gateway/config.json`.

## How it works

ChatGPT is prompted to produce fenced `bash` blocks for commands it wants
OpenCode to run, and to use ordinary prose for explanations. The gateway:

1. Parses only explicitly labelled `bash` blocks (not `text`, `json`, unlabelled
   blocks or inline code).
2. Converts each block into a valid OpenAI-compatible tool call using the Bash
   tool definition supplied by OpenCode.
3. Removes the executed block from the visible assistant content while
   preserving surrounding prose and reasoning output.
4. Returns the tool result to ChatGPT on the next request so it can inspect the
   output and continue or give a final answer.

The gateway never executes commands itself; OpenCode runs them with its built-in
Bash tool.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
