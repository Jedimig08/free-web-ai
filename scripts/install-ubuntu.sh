#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_URL="https://github.com/Jedimig08/free-web-ai.git"
readonly BRANCH="all-permitions-chatgpt"
readonly DEFAULT_INSTALL_DIR="${HOME}/free-web-ai"
readonly OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
readonly GATEWAY_DIR="${HOME}/.token-free-gateway"
readonly GATEWAY_CONFIG="${GATEWAY_DIR}/config.json"
readonly AUTH_PROFILES="${GATEWAY_DIR}/auth-profiles.json"
readonly UNIT_DIR="${HOME}/.config/systemd/user"

INSTALL_DIR="${FREE_WEB_AI_DIR:-${DEFAULT_INSTALL_DIR}}"
SKIP_LOGIN="${FREE_WEB_AI_SKIP_LOGIN:-0}"
NO_SERVICE="${FREE_WEB_AI_NO_SERVICE:-0}"
FORCE_HEADLESS="${FREE_WEB_AI_HEADLESS:-0}"

HEADLESS=0
SYSTEMD_OK=0
LOGIN_OK=0
GATEWAY_PORT=""
GATEWAY_CDP_URL=""
API_KEY=""
OC_CONFIG=""

trap 'printf "\n[free-web-ai installer] ERROR at line %s\n" "$LINENO" >&2' ERR

log() {
	printf '\n[free-web-ai installer] %s\n' "$*"
}

warn() {
	printf '\n[free-web-ai installer] WARNING: %s\n' "$*" >&2
}

die() {
	printf '\n[free-web-ai installer] ERROR: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: scripts/install-ubuntu.sh [options]

Installs Bun, OpenCode V2, Chromium, the free-web-ai project, a generated
gateway API key, the OpenCode provider config, the browser login and the
gateway service on Ubuntu/Debian.

Options:
  --no-login      Do not run the interactive ChatGPT browser login.
  --no-service    Do not install/enable the systemd user service.
  --headless      Force a virtual display + VNC session (no desktop needed).
  -h, --help      Show this help.

Environment:
  FREE_WEB_AI_DIR           Install directory (default: ~/free-web-ai)
  FREE_WEB_AI_SKIP_LOGIN    Set to 1 to skip login
  FREE_WEB_AI_NO_SERVICE    Set to 1 to skip the systemd service
  FREE_WEB_AI_HEADLESS      Set to 1 to force headless mode
  TFG_PORT                  Gateway port (default: 3456)
  TFG_API_KEY               Use a specific gateway API key
  TFG_CDP_URL               Chrome debug URL (default: http://127.0.0.1:9222)
EOF
}

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--no-login) SKIP_LOGIN=1 ;;
			--no-service) NO_SERVICE=1 ;;
			--headless) FORCE_HEADLESS=1 ;;
			-h|--help) usage; exit 0 ;;
			*) die "Unknown option: $1 (use --help)" ;;
		esac
		shift
	done
}

require_linux() {
	[[ "$(uname -s)" == "Linux" ]] || die "Linux is required."
	[[ -r /etc/os-release ]] || die "Cannot identify this distribution: /etc/os-release is missing."
	# shellcheck disable=SC1091
	. /etc/os-release
	case "${ID:-}" in
		ubuntu|debian) ;;
		*) die "Ubuntu or Debian is required. Detected: ${PRETTY_NAME:-unknown}." ;;
	esac
	command -v apt-get >/dev/null 2>&1 || die "apt-get is required."
}

detect_privileges() {
	if [[ "$EUID" -eq 0 ]]; then
		SUDO=()
		warn "Running as root. Chrome refuses to start as root, so the browser login and gateway will not work. Prefer running this installer as a normal user with sudo."
	else
		command -v sudo >/dev/null 2>&1 || die "Install sudo or run this script as root."
		SUDO=(sudo)
	fi
}

detect_headless() {
	if [[ "$FORCE_HEADLESS" == "1" ]]; then
		HEADLESS=1
	elif [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
		HEADLESS=0
	else
		HEADLESS=1
	fi
}

apt_update() {
	"${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get update
}

apt_install() {
	"${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

install_system_dependencies() {
	log "Installing system dependencies..."
	apt_update

	apt_install git curl unzip ca-certificates procps
	if [[ "$HEADLESS" == "1" ]]; then
		apt_install xvfb || die "Could not install Xvfb."
		apt_install x11vnc || warn "Could not install x11vnc; the virtual display will not be reachable remotely."
	fi
}

ensure_shell_path() {
	export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
	export PATH="${BUN_INSTALL}/bin:${HOME}/.opencode/bin:${HOME}/.local/bin:${HOME}/bin:${PATH}"

	local marker="# >>> free-web-ai installer >>>"
	local block
	block="${marker}
export BUN_INSTALL=\"${BUN_INSTALL}\"
case \":\${PATH}:\" in *\":\${BUN_INSTALL}/bin:\"*) ;; *) export PATH=\"\${BUN_INSTALL}/bin:\${PATH}\" ;; esac
case \":\${PATH}:\" in *\":\${HOME}/.opencode/bin:\"*) ;; *) export PATH=\"\${HOME}/.opencode/bin:\${PATH}\" ;; esac
# <<< free-web-ai installer <<<"

	local rc
	for rc in "${HOME}/.bashrc" "${HOME}/.profile"; do
		[[ -e "$rc" ]] || touch "$rc"
		if ! grep -qF "$marker" "$rc"; then
			printf '\n%s\n' "$block" >> "$rc"
		fi
	done
}

install_bun() {
	log "Installing/updating Bun..."
	curl -fsSL https://bun.com/install | bash
	export PATH="${BUN_INSTALL}/bin:${PATH}"
	command -v bun >/dev/null 2>&1 ||
		die "Bun was installed but is not available on PATH. Open a new login shell and rerun this script."
}

install_opencode() {
	log "Installing/updating OpenCode V2..."
	curl -fsSL https://opencode.ai/v2/install | bash
	export PATH="${HOME}/.opencode/bin:${HOME}/.local/bin:${HOME}/bin:${PATH}"
	command -v opencode >/dev/null 2>&1 ||
		die "OpenCode was installed but is not available on PATH. Open a new login shell and rerun this script."
}

install_project() {
	if [[ -e "$INSTALL_DIR" ]]; then
		[[ -d "$INSTALL_DIR/.git" ]] ||
			die "$INSTALL_DIR already exists and is not a Git repository. Move it or set FREE_WEB_AI_DIR."

		local current_branch
		current_branch="$(git -C "$INSTALL_DIR" branch --show-current)"
		[[ "$current_branch" == "$BRANCH" ]] ||
			die "$INSTALL_DIR is on branch '$current_branch', not '$BRANCH'. Switch branches manually or set FREE_WEB_AI_DIR."

		if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
			die "$INSTALL_DIR has uncommitted changes. Commit or stash them before rerunning; the installer will not overwrite them."
		fi

		log "Updating the existing $BRANCH checkout (fast-forward only)..."
		git -C "$INSTALL_DIR" fetch origin "$BRANCH"
		git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
	else
		log "Cloning $BRANCH..."
		git clone --single-branch --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
	fi
}

install_project_dependencies() {
	log "Installing project dependencies..."
	(
		cd "$INSTALL_DIR"
		bun install
	)
}

find_browser() {
	local candidate
	for candidate in \
		/opt/google/chrome/google-chrome \
		/usr/bin/google-chrome \
		/usr/bin/google-chrome-stable \
		/usr/bin/chromium \
		/usr/bin/chromium-browser \
		/snap/bin/chromium; do
		if [[ -x "$candidate" ]]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done

	local command_name
	for command_name in google-chrome google-chrome-stable chromium chromium-browser; do
		if candidate="$(command -v "$command_name" 2>/dev/null)"; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done

	return 1
}

install_browser() {
	local existing
	if existing="$(find_browser)"; then
		log "Browser already installed: $existing"
		return
	fi

	local arch url deb
	arch="$(dpkg --print-architecture)"
	case "$arch" in
		amd64) url="https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" ;;
		arm64) url="https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb" ;;
		*)
			warn "No Google Chrome package for '$arch'; trying the distro chromium package."
			apt_install chromium || die "Could not install a browser for '$arch'."
			return
			;;
	esac

	log "Installing Google Chrome ($arch)..."
	deb="$(mktemp --suffix=.deb)"
	if ! curl -fsSL "$url" -o "$deb"; then
		rm -f "$deb"
		warn "Could not download Google Chrome; trying the distro chromium package."
		apt_install chromium || die "Could not install a browser."
		return
	fi
	if ! apt_install "$deb"; then
		rm -f "$deb"
		warn "Could not install Google Chrome; trying the distro chromium package."
		apt_install chromium || die "Could not install a browser."
		return
	fi
	rm -f "$deb"

	find_browser >/dev/null || die "Chrome was installed but could not be found."
}

read_existing_gateway_config() {
	local cfg_port="" cfg_key="" cfg_cdp=""
	if [[ -f "$GATEWAY_CONFIG" ]]; then
		IFS=$'\t' read -r cfg_port cfg_key cfg_cdp < <(
			GATEWAY_CONFIG_FILE="$GATEWAY_CONFIG" bun -e '
				try {
					const c = JSON.parse(require("node:fs").readFileSync(process.env.GATEWAY_CONFIG_FILE, "utf8"));
					process.stdout.write([c.port ?? "", c.apiKey ?? "", c.cdpUrl ?? ""].join("\t"));
				} catch {}
			'
		) || true
	fi

	GATEWAY_PORT="${TFG_PORT:-${cfg_port:-3456}}"
	API_KEY="${TFG_API_KEY:-${cfg_key:-}}"
	GATEWAY_CDP_URL="${TFG_CDP_URL:-${cfg_cdp:-http://127.0.0.1:9222}}"
}

generate_api_key() {
	bun -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

write_gateway_config() {
	GATEWAY_PORT="${GATEWAY_PORT:-3456}"
	GATEWAY_CDP_URL="${GATEWAY_CDP_URL:-http://127.0.0.1:9222}"
	if [[ -z "$API_KEY" ]]; then
		API_KEY="$(generate_api_key)"
	fi

	log "Writing gateway config..."
	mkdir -p "$GATEWAY_DIR"
	chmod 700 "$GATEWAY_DIR"
	GATEWAY_CONFIG_FILE="$GATEWAY_CONFIG" \
	GATEWAY_PORT_VALUE="$GATEWAY_PORT" \
	GATEWAY_API_KEY_VALUE="$API_KEY" \
	GATEWAY_CDP_URL_VALUE="$GATEWAY_CDP_URL" \
	bun -e '
		const fs = require("node:fs");
		const path = require("node:path");
		const file = process.env.GATEWAY_CONFIG_FILE;
		let config = {};
		try {
			config = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		config.port = Number(process.env.GATEWAY_PORT_VALUE);
		config.apiKey = process.env.GATEWAY_API_KEY_VALUE;
		config.cdpUrl = process.env.GATEWAY_CDP_URL_VALUE;
		if (!config.requestTimeoutSec) config.requestTimeoutSec = 300;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
	'
	chmod 600 "$GATEWAY_CONFIG"
}

configure_opencode() {
	mkdir -p "$OPENCODE_CONFIG_DIR"

	if [[ -f "${OPENCODE_CONFIG_DIR}/opencode.jsonc" ]]; then
		OC_CONFIG="${OPENCODE_CONFIG_DIR}/opencode.jsonc"
	elif [[ -f "${OPENCODE_CONFIG_DIR}/opencode.json" ]]; then
		OC_CONFIG="${OPENCODE_CONFIG_DIR}/opencode.json"
	else
		OC_CONFIG="${OPENCODE_CONFIG_DIR}/opencode.json"
	fi

	if [[ -f "$OC_CONFIG" ]]; then
		cp "$OC_CONFIG" "${OC_CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
	fi

	log "Configuring the OpenCode 'free-web-ai' provider..."
	# shellcheck disable=SC2016
	OC_CONFIG_PATH="$OC_CONFIG" \
	OC_BASE_URL="http://127.0.0.1:${GATEWAY_PORT}/v1" \
	OC_API_KEY="$API_KEY" \
	bun -e '
		const fs = require("node:fs");

		function stripJsonc(input) {
			let out = "";
			let i = 0;
			let inString = false;
			let quote = "\"";
			let escaped = false;
			let inLineComment = false;
			let inBlockComment = false;
			while (i < input.length) {
				const ch = input[i];
				const next = input[i + 1];
				if (inLineComment) {
					if (ch === "\n") {
						inLineComment = false;
						out += ch;
					}
					i++;
					continue;
				}
				if (inBlockComment) {
					if (ch === "*" && next === "/") {
						inBlockComment = false;
						i += 2;
					} else {
						i++;
					}
					continue;
				}
				if (inString) {
					out += ch;
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === quote) inString = false;
					i++;
					continue;
				}
				if (ch === "\"" || ch === "\x27") {
					inString = true;
					quote = ch;
					out += ch;
					i++;
					continue;
				}
				if (ch === "/" && next === "/") {
					inLineComment = true;
					i += 2;
					continue;
				}
				if (ch === "/" && next === "*") {
					inBlockComment = true;
					i += 2;
					continue;
				}
				out += ch;
				i++;
			}
			return out;
		}

		function removeTrailingCommas(input) {
			let out = "";
			let inString = false;
			let quote = "\"";
			let escaped = false;
			for (let i = 0; i < input.length; i++) {
				const ch = input[i];
				if (inString) {
					out += ch;
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === quote) inString = false;
					continue;
				}
				if (ch === "\"" || ch === "\x27") {
					inString = true;
					quote = ch;
					out += ch;
					continue;
				}
				if (ch === ",") {
					let j = i + 1;
					while (j < input.length && /\s/.test(input[j])) j++;
					if (input[j] === "}" || input[j] === "]") continue;
				}
				out += ch;
			}
			return out;
		}

		const file = process.env.OC_CONFIG_PATH;
		let config = {};
		if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim() !== "") {
			const raw = fs.readFileSync(file, "utf8");
			try {
				config = JSON.parse(removeTrailingCommas(stripJsonc(raw)));
			} catch (error) {
				console.error(`Could not parse ${file}: ${error.message}`);
				process.exit(2);
			}
		}
		if (!config || typeof config !== "object" || Array.isArray(config)) config = {};

		config.$schema = config.$schema || "https://opencode.ai/config.json";
		config.provider = config.provider || {};
		const previous = config.provider["free-web-ai"] || {};
		const previousOptions = previous.options || {};
		config.provider["free-web-ai"] = {
			...previous,
			npm: previous.npm || "@ai-sdk/openai-compatible",
			name: previous.name || "Free Web AI (ChatGPT bridge)",
			options: {
				...previousOptions,
				baseURL: process.env.OC_BASE_URL,
				apiKey: process.env.OC_API_KEY,
				headerTimeout: previousOptions.headerTimeout ?? 900000,
				timeout: previousOptions.timeout ?? 900000,
			},
			models: {
				...(previous.models || {}),
				"chatgpt-auto": { name: "ChatGPT Auto (web)", tool_call: true },
				"chatgpt-think": { name: "ChatGPT Think (web)", tool_call: true },
			},
		};
		if (!config.model) config.model = "free-web-ai/chatgpt-auto";
		if (!config.small_model) config.small_model = config.model;

		fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
	'
}

systemd_user_available() {
	[[ "$EUID" -ne 0 ]] || return 1
	command -v systemctl >/dev/null 2>&1 || return 1

	if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then
		XDG_RUNTIME_DIR="/run/user/$(id -u)"
		export XDG_RUNTIME_DIR
	fi
	[[ -n "${XDG_RUNTIME_DIR:-}" ]] || return 1
	systemctl --user show-environment >/dev/null 2>&1
}

write_xvfb_units() {
	mkdir -p "$UNIT_DIR"
	cat > "${UNIT_DIR}/free-web-ai-xvfb.service" <<'EOF'
[Unit]
Description=Virtual X display for Free Web AI
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -nolisten tcp
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

	local x11vnc_bin
	x11vnc_bin="$(command -v x11vnc || true)"
	if [[ -n "$x11vnc_bin" ]]; then
		cat > "${UNIT_DIR}/free-web-ai-vnc.service" <<EOF
[Unit]
Description=VNC access to the Free Web AI virtual display
After=free-web-ai-xvfb.service
Wants=free-web-ai-xvfb.service

[Service]
Type=simple
ExecStart=${x11vnc_bin} -display :99 -localhost -forever -shared -nopw -rfbport 5900
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
	fi
}

start_xvfb_background() {
	mkdir -p "$GATEWAY_DIR"
	if ! pgrep -f "Xvfb :99" >/dev/null 2>&1; then
		nohup Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >"${GATEWAY_DIR}/xvfb.log" 2>&1 &
	fi
	local _i
	for _i in {1..50}; do
		[[ -S /tmp/.X11-unix/X99 ]] && break
		sleep 0.1
	done
	[[ -S /tmp/.X11-unix/X99 ]] || die "Failed to start Xvfb. See ${GATEWAY_DIR}/xvfb.log"
}

start_vnc_background() {
	command -v x11vnc >/dev/null 2>&1 || return 0
	if ! pgrep -f "x11vnc.*-rfbport 5900" >/dev/null 2>&1; then
		nohup x11vnc -display :99 -localhost -forever -shared -nopw -rfbport 5900 \
			>"${GATEWAY_DIR}/x11vnc.log" 2>&1 &
	fi
}

prepare_headless() {
	export DISPLAY=:99
	log "No graphical display detected; preparing a virtual display on :99..."

	if [[ "$SYSTEMD_OK" == "1" ]]; then
		write_xvfb_units
		systemctl --user daemon-reload
		systemctl --user enable --now free-web-ai-xvfb.service ||
			die "Failed to start the virtual display service."
		if [[ -f "${UNIT_DIR}/free-web-ai-vnc.service" ]]; then
			systemctl --user enable --now free-web-ai-vnc.service ||
				warn "Failed to start the VNC service."
		fi
		local _i
		for _i in {1..50}; do
			[[ -S /tmp/.X11-unix/X99 ]] && break
			sleep 0.1
		done
	else
		start_xvfb_background
		start_vnc_background
	fi
}

print_vnc_help() {
	if [[ "$HEADLESS" != "1" ]]; then
		return
	fi

	local host
	host="$(hostname 2>/dev/null || echo localhost)"
	log "A virtual desktop is available on display :99."
	printf 'Connect to it from your computer with an SSH tunnel:\n'
	printf '  ssh -L 5900:127.0.0.1:5900 %s@%s\n' "${USER:-user}" "$host"
	printf 'Then open your VNC client and connect to 127.0.0.1:5900.\n'
}

login_chatgpt() {
	if [[ -f "$AUTH_PROFILES" ]]; then
		LOGIN_OK=1
		log "Existing ChatGPT credentials found; skipping the interactive login."
		return
	fi

	if [[ "$SKIP_LOGIN" == "1" ]]; then
		warn "Skipping the interactive ChatGPT login (--no-login)."
		return
	fi

	print_vnc_help

	log "Starting Chrome for the ChatGPT login..."
	if ! (
		cd "$INSTALL_DIR"
		bun index.ts chrome start
	); then
		warn "Could not start Chrome. Retry later with: cd \"$INSTALL_DIR\" && bun index.ts chrome start"
		return
	fi

	log "Log in to ChatGPT in the browser window. The installer waits up to 5 minutes."
	if (
		cd "$INSTALL_DIR"
		bun index.ts webauth
	); then
		LOGIN_OK=1
		log "ChatGPT credentials saved."
	else
		warn "ChatGPT login was not completed."
		warn "Retry after installation with: cd \"$INSTALL_DIR\" && bun index.ts webauth"
	fi
}

write_gateway_unit() {
	mkdir -p "$UNIT_DIR"

	local bun_bin unit_path display_env headless_after headless_wants
	bun_bin="$(command -v bun)"
	unit_path="$(dirname "$bun_bin"):${HOME}/.opencode/bin:${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

	display_env=""
	headless_after=""
	headless_wants=""
	if [[ "$HEADLESS" == "1" ]]; then
		display_env='Environment=DISPLAY=:99'
		headless_after=" free-web-ai-xvfb.service"
		headless_wants=" free-web-ai-xvfb.service"
	else
		[[ -n "${DISPLAY:-}" ]] && display_env+="Environment=DISPLAY=${DISPLAY}"$'\n'
		[[ -n "${WAYLAND_DISPLAY:-}" ]] && display_env+="Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY}"$'\n'
		[[ -n "${XAUTHORITY:-}" ]] && display_env+="Environment=XAUTHORITY=${XAUTHORITY}"$'\n'
	fi

	cat > "${UNIT_DIR}/free-web-ai-gateway.service" <<EOF
[Unit]
Description=Free Web AI gateway (ChatGPT web bridge)
After=network-online.target${headless_after}
Wants=network-online.target${headless_wants}

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
Environment=HOME=${HOME}
Environment="PATH=${unit_path}"
Environment=TFG_CDP_URL=${GATEWAY_CDP_URL}
${display_env}
ExecStartPre=-${bun_bin} ${INSTALL_DIR}/index.ts chrome start
ExecStart=${bun_bin} ${INSTALL_DIR}/index.ts serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

start_gateway() {
	if [[ "$NO_SERVICE" != "1" && "$SYSTEMD_OK" == "1" ]]; then
		log "Installing the gateway systemd user service..."
		if command -v loginctl >/dev/null 2>&1; then
			"${SUDO[@]}" loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
				warn "Could not enable systemd lingering; the gateway will stop when you log out."
		fi
		write_gateway_unit
		systemctl --user daemon-reload
		if systemctl --user enable --now free-web-ai-gateway.service; then
			log "Gateway service started."
			return
		fi
		warn "Could not start the systemd user service; using the built-in daemon instead."
	fi

	log "Starting the gateway daemon..."
	(
		cd "$INSTALL_DIR"
		bun index.ts start
	) || die "Failed to start the gateway. Check ${GATEWAY_DIR}/gateway.log"
}

verify_gateway() {
	local health="" models=""
	local _i
	for _i in {1..30}; do
		health="$(curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null || true)"
		[[ -n "$health" ]] && break
		sleep 0.5
	done

	if [[ -z "$health" ]]; then
		warn "The gateway did not answer on port ${GATEWAY_PORT} yet."
		return
	fi

	log "Gateway health: ${health}"
	models="$(curl -fsS -H "Authorization: Bearer ${API_KEY}" \
		"http://127.0.0.1:${GATEWAY_PORT}/v1/models" 2>/dev/null || true)"
	if [[ -n "$models" ]]; then
		log "Gateway models: ${models}"
	fi
}

print_summary() {
	printf '\n'
	log "Installation completed."
	printf 'Project:    %s\n' "$INSTALL_DIR"
	printf 'Branch:     %s\n' "$BRANCH"
	printf 'Gateway:    http://127.0.0.1:%s/v1\n' "$GATEWAY_PORT"
	printf 'API key:    stored in %s\n' "$GATEWAY_CONFIG"
	printf 'Config:     %s\n' "$OC_CONFIG"

	if command -v opencode >/dev/null 2>&1; then
		printf 'OpenCode:   %s\n' "$(opencode --version 2>/dev/null || echo installed)"
	fi
	printf 'Bun:        %s\n' "$(bun --version 2>/dev/null || echo installed)"

	printf '\nNext steps:\n'
	printf '  1. Open a new shell, or run: source ~/.bashrc\n'
	printf '  2. cd "%s"\n' "$INSTALL_DIR"
	printf '  3. opencode\n'
	printf '  4. Choose model: free-web-ai/chatgpt-auto\n'

	if [[ "$LOGIN_OK" != "1" ]]; then
		printf '\nChatGPT login is not complete yet:\n'
		printf '  cd "%s" && bun index.ts webauth\n' "$INSTALL_DIR"
	fi

	if [[ "$HEADLESS" == "1" ]]; then
		printf '\nTo reach the virtual desktop again:\n'
		printf '  ssh -L 5900:127.0.0.1:5900 %s@%s\n' "${USER:-user}" "$(hostname 2>/dev/null || echo localhost)"
		printf '  connect a VNC client to 127.0.0.1:5900\n'
	fi

	printf '\nGateway management:\n'
	printf '  systemctl --user status free-web-ai-gateway.service   (service mode)\n'
	printf '  systemctl --user restart free-web-ai-gateway.service  (service mode)\n'
	printf '  cd "%s" && bun index.ts status                       (daemon mode)\n' "$INSTALL_DIR"
}

main() {
	parse_args "$@"
	require_linux
	detect_privileges
	detect_headless
	ensure_shell_path
	install_system_dependencies
	install_bun
	install_opencode
	install_project
	install_project_dependencies
	install_browser
	read_existing_gateway_config
	write_gateway_config
	configure_opencode

	if [[ "$NO_SERVICE" != "1" ]] && systemd_user_available; then
		SYSTEMD_OK=1
	fi

	if [[ "$HEADLESS" == "1" ]]; then
		prepare_headless
	fi

	login_chatgpt
	start_gateway
	verify_gateway
	print_summary
}

main "$@"
