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
- An OpenCode web UI and, on headless servers, a noVNC login page
- An optional local frontpage linking the web UIs

## Requirements

- Ubuntu or Debian
- A normal user with sudo (Chromium will not run as root)
- Network access to install Bun, OpenCode and Chromium

## Install

The branch ships a one-command installer that sets up Bun, OpenCode V2,
Chromium, the gateway, the OpenCode web UI and, in headless mode, the noVNC
login page. It clones the branch to `~/free-web-ai`, so no checkout is needed
first.

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

Relevant environment variables: `OPENCODE_WEB_PORT` (default `4096`),
`FREE_WEB_AI_NOVNC_PORT` (default `6080`), `TFG_PORT` (default `3456`) and
`FREE_WEB_AI_FRONTPAGE_PORT` (default `8080`).

After a successful install:

| Service | URL |
| --- | --- |
| OpenCode web UI | `http://<server>:4096` |
| noVNC login page | `http://<server>:6080/vnc.html?autoconnect=1&resize=scale` |
| Gateway API | `http://<server>:3456/v1` |
| Frontpage (optional) | `http://<server>:8080` |

## Optional frontpage

The frontpage is a standalone file in the repository
(`frontpage/index.html`), not embedded in the installer. It links the web UIs
running on the machine (OpenCode, noVNC and the gateway) and shows their
reachability. It is installed only when requested:

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

1. Open the OpenCode web UI at `http://<server>:4096` and log in with username
   `opencode`; the password is in `~/.config/opencode/web.env`.
2. Select the model `free-web-ai/chatgpt-auto`.
3. Point any OpenAI-compatible client at `http://<server>:3456/v1`, using the
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
