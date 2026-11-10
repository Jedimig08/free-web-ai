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
readonly WEB_ENV="${OPENCODE_CONFIG_DIR}/web.env"
readonly VNC_PASS_FILE="${GATEWAY_DIR}/vnc.pass"
readonly VNC_PASSWORD_FILE="${GATEWAY_DIR}/vnc-password.txt"

INSTALL_DIR="${FREE_WEB_AI_DIR:-${DEFAULT_INSTALL_DIR}}"
SKIP_LOGIN="${FREE_WEB_AI_SKIP_LOGIN:-0}"
NO_SERVICE="${FREE_WEB_AI_NO_SERVICE:-0}"
FORCE_HEADLESS="${FREE_WEB_AI_HEADLESS:-0}"
WEB_PORT="${OPENCODE_WEB_PORT:-4096}"
NOVNC_PORT="${FREE_WEB_AI_NOVNC_PORT:-6080}"
NOVNC_WEB_DIR="${FREE_WEB_AI_NOVNC_WEB_DIR:-/usr/share/novnc}"
FRONTPAGE="${FREE_WEB_AI_FRONTPAGE:-0}"
FRONTPAGE_PORT="${FREE_WEB_AI_FRONTPAGE_PORT:-8080}"
FRONTPAGE_DIR="${GATEWAY_DIR}/frontpage"

HEADLESS=0
SYSTEMD_OK=0
LOGIN_OK=0
GATEWAY_PORT=""
GATEWAY_CDP_URL=""
API_KEY=""
OC_CONFIG=""
WEB_PASSWORD=""
VNC_PASSWORD=""

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
  --headless      Force a virtual display + browser login page (no desktop needed).
  --frontpage     Install and start the optional pi3B frontpage.
  --no-frontpage  Do not install the frontpage (default).
  --frontpage-port PORT  Port for the frontpage server (default: 8080).
  -h, --help      Show this help.

Environment:
  FREE_WEB_AI_DIR           Install directory (default: ~/free-web-ai)
  FREE_WEB_AI_SKIP_LOGIN    Set to 1 to skip login
  FREE_WEB_AI_NO_SERVICE    Set to 1 to skip the systemd service
  FREE_WEB_AI_HEADLESS      Set to 1 to force headless mode
  FREE_WEB_AI_FRONTPAGE     Set to 1 to install the pi3B frontpage
  FREE_WEB_AI_FRONTPAGE_PORT Frontpage port (default: 8080)
  TFG_PORT                  Gateway port (default: 3456)
  TFG_API_KEY               Use a specific gateway API key
  TFG_CDP_URL               Chrome debug URL (default: http://127.0.0.1:9222)
  OPENCODE_WEB_PORT         OpenCode web UI port (default: 4096)
  OPENCODE_SERVER_PASSWORD  Password for the OpenCode web UI
  FREE_WEB_AI_NOVNC_PORT    Browser login (noVNC) port (default: 6080)
  FREE_WEB_AI_NOVNC_WEB_DIR noVNC web directory (default: /usr/share/novnc)
  FREE_WEB_AI_PUBLIC_IP     IP address shown in login URLs (auto-detected)
EOF
}

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--no-login) SKIP_LOGIN=1 ;;
			--no-service) NO_SERVICE=1 ;;
			--headless) FORCE_HEADLESS=1 ;;
			--frontpage) FRONTPAGE=1 ;;
			--no-frontpage) FRONTPAGE=0 ;;
			--frontpage-port)
				[[ $# -ge 2 ]] || die "Missing value for --frontpage-port (use --help)"
				FRONTPAGE_PORT="$2"
				shift
				;;
			--frontpage-port=*) FRONTPAGE_PORT="${1#*=}" ;;
			-h|--help) usage; exit 0 ;;
			*) die "Unknown option: $1 (use --help)" ;;
		esac
		shift
	done

	if [[ ! "$FRONTPAGE_PORT" =~ ^[0-9]+$ ]] || (( FRONTPAGE_PORT < 1 || FRONTPAGE_PORT > 65535 )); then
		die "Invalid frontpage port: $FRONTPAGE_PORT"
	fi
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
		apt_install novnc websockify ||
			warn "Could not install noVNC; the browser login page will be unavailable."
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

generate_vnc_password() {
	bun -e '
		const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
		const bytes = require("node:crypto").randomBytes(8);
		let password = "";
		for (const byte of bytes) password += alphabet[byte % alphabet.length];
		process.stdout.write(password);
	'
}

prepare_vnc_password() {
	mkdir -p "$GATEWAY_DIR"
	chmod 700 "$GATEWAY_DIR"

	if [[ -f "$VNC_PASSWORD_FILE" ]]; then
		VNC_PASSWORD="$(tr -d '\r\n' <"$VNC_PASSWORD_FILE")"
	fi
	if [[ ${#VNC_PASSWORD} -ne 8 ]]; then
		VNC_PASSWORD="$(generate_vnc_password)"
	fi

	printf '%s\n' "$VNC_PASSWORD" >"$VNC_PASSWORD_FILE"
	chmod 600 "$VNC_PASSWORD_FILE"

	if command -v x11vnc >/dev/null 2>&1; then
		x11vnc -storepasswd "$VNC_PASSWORD" "$VNC_PASS_FILE" >/dev/null 2>&1 ||
			warn "Could not store the VNC password file."
		chmod 600 "$VNC_PASS_FILE" 2>/dev/null || true
	fi
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

read_existing_web_password() {
	[[ -f "$WEB_ENV" ]] || return 0
	(
		set +u
		# shellcheck disable=SC1090
		. "$WEB_ENV" >/dev/null 2>&1 || true
		printf '%s' "${OPENCODE_SERVER_PASSWORD:-}"
	)
}

write_web_env() {
	mkdir -p "$OPENCODE_CONFIG_DIR"
	local tmp
	tmp="$(mktemp)"
	if [[ -f "$WEB_ENV" ]]; then
		grep -vE '^(export[[:space:]]+)?OPENCODE_SERVER_PASSWORD=' "$WEB_ENV" >"$tmp" || true
	fi
	printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$WEB_PASSWORD" >>"$tmp"
	mv "$tmp" "$WEB_ENV"
	chmod 600 "$WEB_ENV"
}

write_opencode_web_unit() {
	local opencode_bin="$1"
	mkdir -p "$UNIT_DIR"
	cat >"${UNIT_DIR}/opencode-web.service" <<EOF
[Unit]
Description=OpenCode Web Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=HOME=%h
Environment="PATH=$(dirname "$opencode_bin"):${HOME}/.bun/bin:${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
EnvironmentFile=${WEB_ENV}
ExecStart=${opencode_bin} serve --hostname 0.0.0.0 --port ${WEB_PORT} --print-logs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

start_opencode_web() {
	local opencode_bin
	opencode_bin="$(command -v opencode)" || die "OpenCode is not installed."

	WEB_PASSWORD="${OPENCODE_SERVER_PASSWORD:-$(read_existing_web_password)}"
	if [[ -z "$WEB_PASSWORD" ]]; then
		WEB_PASSWORD="$(generate_api_key)"
	fi
	if [[ ! "$WEB_PASSWORD" =~ ^[A-Za-z0-9._~!@%^+=:-]+$ ]]; then
		warn "The existing OpenCode web password contains unsupported characters; generating a new one."
		WEB_PASSWORD="$(generate_api_key)"
	fi
	if [[ ${#WEB_PASSWORD} -lt 12 ]]; then
		warn "The OpenCode web password is shorter than 12 characters; consider changing it in $WEB_ENV."
	fi
	write_web_env

	log "Installing the OpenCode web service on port ${WEB_PORT}..."
	if [[ "$NO_SERVICE" != "1" && "$SYSTEMD_OK" == "1" ]]; then
		if command -v loginctl >/dev/null 2>&1; then
			"${SUDO[@]}" loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
				warn "Could not enable systemd lingering; the web UI will stop when you log out."
		fi

		write_opencode_web_unit "$opencode_bin"
		systemctl --user daemon-reload
		if systemctl --user enable opencode-web.service >/dev/null 2>&1 &&
			systemctl --user restart opencode-web.service >/dev/null 2>&1; then
			log "OpenCode web service started."
			print_web_urls
			return
		fi
		warn "Could not start the OpenCode web systemd service; using a background process."
	fi

	local web_log="${HOME}/opencode-web.log"
	(
		set -a
		# shellcheck disable=SC1090
		. "$WEB_ENV"
		set +a
		nohup "$opencode_bin" serve --hostname 0.0.0.0 --port "$WEB_PORT" --print-logs \
			>"$web_log" 2>&1 &
	)
	log "OpenCode web started in the background; log: $web_log"
	print_web_urls
}

verify_opencode_web() {
	local code="" _i
	for _i in {1..30}; do
		code="$(curl -s -o /dev/null -w '%{http_code}' \
			-u "opencode:${WEB_PASSWORD}" "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || true)"
		[[ "$code" == "200" ]] && break
		sleep 0.5
	done

	if [[ "$code" == "200" ]]; then
		log "OpenCode web UI is running on port ${WEB_PORT}."
	else
		warn "OpenCode web UI did not return HTTP 200 on port ${WEB_PORT} (got ${code:-no response})."
	fi
}

write_frontpage_unit() {
	mkdir -p "$UNIT_DIR"
	cat >"${UNIT_DIR}/pi3b-frontpage.service" <<EOF
[Unit]
Description=pi3B frontpage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${FRONTPAGE_DIR}
ExecStart=${1} -m http.server ${FRONTPAGE_PORT} --bind 0.0.0.0 --directory ${FRONTPAGE_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
}

install_frontpage() {
	[[ "$FRONTPAGE" == "1" ]] || return 0

	local src python_bin log_file
	src="${INSTALL_DIR}/frontpage/index.html"
	if [[ ! -f "$src" ]]; then
		warn "Frontpage files not found in ${INSTALL_DIR}; skipping."
		return 0
	fi

	python_bin="$(command -v python3 || true)"
	if [[ -z "$python_bin" ]]; then
		warn "python3 is required to serve the frontpage; skipping."
		return 0
	fi

	log "Installing the frontpage on port ${FRONTPAGE_PORT}..."
	mkdir -p "$FRONTPAGE_DIR"
	cp "$src" "${FRONTPAGE_DIR}/index.html"
	printf '{"opencode":%s,"novnc":%s,"gateway":%s}\n' \
		"$WEB_PORT" "$NOVNC_PORT" "$GATEWAY_PORT" >"${FRONTPAGE_DIR}/frontpage.json"

	if [[ "$NO_SERVICE" != "1" && "$SYSTEMD_OK" == "1" ]]; then
		write_frontpage_unit "$python_bin"
		systemctl --user daemon-reload
		if systemctl --user enable --now pi3b-frontpage.service >/dev/null 2>&1; then
			log "Frontpage service started."
			return
		fi
		warn "Could not start the frontpage systemd service; using a background process."
	fi

	if pgrep -f "http.server ${FRONTPAGE_PORT}.*${FRONTPAGE_DIR}" >/dev/null 2>&1; then
		log "Frontpage is already running on port ${FRONTPAGE_PORT}."
		return
	fi

	log_file="${GATEWAY_DIR}/frontpage.log"
	nohup "$python_bin" -m http.server "$FRONTPAGE_PORT" --bind 0.0.0.0 \
		--directory "$FRONTPAGE_DIR" >"$log_file" 2>&1 &
	log "Frontpage started in the background; log: $log_file"
}

verify_frontpage() {
	[[ "$FRONTPAGE" == "1" ]] || return 0

	local code="" _i
	for _i in {1..20}; do
		code="$(curl -s -o /dev/null -w '%{http_code}' \
			"http://127.0.0.1:${FRONTPAGE_PORT}/" 2>/dev/null || true)"
		[[ "$code" == "200" ]] && break
		sleep 0.5
	done

	if [[ "$code" == "200" ]]; then
		log "Frontpage is running on port ${FRONTPAGE_PORT}."
	else
		warn "Frontpage did not return HTTP 200 on port ${FRONTPAGE_PORT} (got ${code:-no response})."
	fi
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
	cat >"${UNIT_DIR}/free-web-ai-xvfb.service" <<'EOF'
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

	local x11vnc_bin websockify_bin novnc_dir
	x11vnc_bin="$(command -v x11vnc || true)"
	if [[ -n "$x11vnc_bin" ]]; then
		cat >"${UNIT_DIR}/free-web-ai-vnc.service" <<EOF
[Unit]
Description=VNC access to the Free Web AI virtual display
After=free-web-ai-xvfb.service
Wants=free-web-ai-xvfb.service

[Service]
Type=simple
ExecStart=${x11vnc_bin} -display :99 -localhost -forever -shared -rfbauth ${VNC_PASS_FILE} -rfbport 5900
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
	fi

	websockify_bin="$(command -v websockify || true)"
	novnc_dir="${NOVNC_WEB_DIR}"
	if [[ -n "$websockify_bin" && -f "${novnc_dir}/vnc.html" ]]; then
		cat >"${UNIT_DIR}/free-web-ai-novnc.service" <<EOF
[Unit]
Description=Browser login for Free Web AI
After=free-web-ai-vnc.service
Wants=free-web-ai-vnc.service

[Service]
Type=simple
ExecStart=${websockify_bin} --web=${novnc_dir} ${NOVNC_PORT} 127.0.0.1:5900
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
		nohup x11vnc -display :99 -localhost -forever -shared -rfbauth "$VNC_PASS_FILE" -rfbport 5900 \
			>"${GATEWAY_DIR}/x11vnc.log" 2>&1 &
	fi
}

start_novnc_background() {
	command -v websockify >/dev/null 2>&1 || return 0
	[[ -f "${NOVNC_WEB_DIR}/vnc.html" ]] || return 0
	if ! pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null 2>&1; then
		nohup websockify --web="${NOVNC_WEB_DIR}" "$NOVNC_PORT" 127.0.0.1:5900 \
			>"${GATEWAY_DIR}/novnc.log" 2>&1 &
	fi
}

prepare_headless() {
	export DISPLAY=:99
	log "No graphical display detected; preparing a virtual display on :99..."
	prepare_vnc_password

	if [[ "$SYSTEMD_OK" == "1" ]]; then
		write_xvfb_units
		systemctl --user daemon-reload
		systemctl --user enable --now free-web-ai-xvfb.service ||
			die "Failed to start the virtual display service."
		if [[ -f "${UNIT_DIR}/free-web-ai-vnc.service" ]]; then
			systemctl --user enable --now free-web-ai-vnc.service ||
				warn "Failed to start the VNC service."
		fi
		if [[ -f "${UNIT_DIR}/free-web-ai-novnc.service" ]]; then
			systemctl --user enable --now free-web-ai-novnc.service ||
				warn "Failed to start the noVNC service."
		fi
		local _i
		for _i in {1..50}; do
			[[ -S /tmp/.X11-unix/X99 ]] && break
			sleep 0.1
		done
	else
		start_xvfb_background
		start_vnc_background
		start_novnc_background
	fi
}

novnc_available() {
	command -v x11vnc >/dev/null 2>&1 &&
		command -v websockify >/dev/null 2>&1 &&
		[[ -f "${NOVNC_WEB_DIR}/vnc.html" ]]
}

print_web_urls() {
	local primary others
	primary="$(get_primary_ip)"
	others="$(get_server_ips | tail -n +2 | paste -sd' ' -)"
	printf 'OpenCode web UI: http://%s:%s\n' "$primary" "$WEB_PORT"
	printf 'OpenCode web UI login: username "opencode", password in %s\n' "$WEB_ENV"
	[[ -z "${others// /}" ]] || printf 'Other server IPs: %s\n' "$others"
}

get_primary_ip() {
	if [[ -n "${FREE_WEB_AI_PUBLIC_IP:-}" ]]; then
		printf '%s\n' "$FREE_WEB_AI_PUBLIC_IP"
		return
	fi

	local ip
	ip="$(ip -4 route get 1.1.1.1 2>/dev/null |
		awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
	if [[ -z "$ip" ]]; then
		ip="$(hostname -I 2>/dev/null | tr ' ' '\n' |
			grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -n1 || true)"
	fi
	[[ -n "$ip" ]] || ip="$(hostname 2>/dev/null || echo localhost)"
	printf '%s\n' "$ip"
}

get_server_ips() {
	if [[ -n "${FREE_WEB_AI_PUBLIC_IP:-}" ]]; then
		printf '%s\n' "$FREE_WEB_AI_PUBLIC_IP"
		return
	fi

	local primary ip ips=""
	primary="$(get_primary_ip)"
	if command -v ip >/dev/null 2>&1; then
		ips="$(ip -4 -o addr show scope global 2>/dev/null |
			awk '$2 !~ /^(lo|docker|br-|virbr|veth|cni|podman|lxc)/ { split($4, a, "/"); print a[1] }' |
			sort -u)"
	fi
	if [[ -z "$ips" ]]; then
		ips="$(hostname -I 2>/dev/null | tr ' ' '\n' |
			grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | sort -u || true)"
	fi
	printf '%s\n' "$primary"
	while IFS= read -r ip; do
		[[ -z "$ip" || "$ip" == "$primary" ]] || printf '%s\n' "$ip"
	done <<<"$ips"
}

print_vnc_help() {
	if [[ "$HEADLESS" != "1" ]]; then
		return
	fi

	local host primary others
	host="$(hostname 2>/dev/null || echo localhost)"
	primary="$(get_primary_ip)"
	others="$(get_server_ips | tail -n +2 | paste -sd' ' -)"

	if novnc_available; then
		log "ChatGPT login required — open this URL in your browser:"
		printf '  http://%s:%s/vnc.html?autoconnect=1&resize=scale\n' "$primary" "$NOVNC_PORT"
		[[ -z "${others// /}" ]] || printf '  (other server IPs: %s)\n' "$others"
		printf '  VNC password: %s\n' "$VNC_PASSWORD"
		printf 'If that port is blocked, tunnel it first:\n'
		printf '  ssh -L %s:127.0.0.1:%s %s@%s\n' "$NOVNC_PORT" "$NOVNC_PORT" "${USER:-user}" "$host"
		printf '  then open http://127.0.0.1:%s/vnc.html?autoconnect=1&resize=scale\n' "$NOVNC_PORT"
	else
		log "ChatGPT login required — a virtual desktop is available on display :99."
		printf 'Server IP: %s\n' "$primary"
		[[ -z "${others// /}" ]] || printf 'Other server IPs: %s\n' "$others"
		printf 'Connect with an SSH tunnel and a VNC client:\n'
		printf '  ssh -L 5900:127.0.0.1:5900 %s@%s\n' "${USER:-user}" "$host"
		printf '  then connect your VNC client to 127.0.0.1:5900\n'
		if [[ -n "$VNC_PASSWORD" ]]; then
			printf '  VNC password: %s\n' "$VNC_PASSWORD"
		fi
	fi
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

	log "Starting Chrome for the ChatGPT login..."
	if ! (
		cd "$INSTALL_DIR"
		bun index.ts chrome start
	); then
		warn "Could not start Chrome. Retry later with: cd \"$INSTALL_DIR\" && bun index.ts chrome start"
		return
	fi

	print_vnc_help

	log "Log in to ChatGPT in the browser window. The installer waits up to 5 minutes."
	if (
		cd "$INSTALL_DIR"
		timeout 330 bun index.ts webauth
	); then
		LOGIN_OK=1
		log "ChatGPT credentials saved."
	elif [[ -f "$AUTH_PROFILES" ]]; then
		LOGIN_OK=1
		warn "The login command did not exit cleanly, but credentials were saved."
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
	local host primary others
	host="$(hostname 2>/dev/null || echo localhost)"
	primary="$(get_primary_ip)"
	others="$(get_server_ips | tail -n +2 | paste -sd' ' -)"

	printf '\n'
	log "Installation completed."
	printf 'Project:    %s\n' "$INSTALL_DIR"
	printf 'Branch:     %s\n' "$BRANCH"
	printf 'Gateway:    http://127.0.0.1:%s/v1\n' "$GATEWAY_PORT"
	printf 'API key:    stored in %s\n' "$GATEWAY_CONFIG"
	printf 'Server IP:  %s\n' "$primary"
	[[ -z "${others// /}" ]] || printf 'Other IPs:  %s\n' "$others"
	printf 'Web UI:     http://%s:%s\n' "$primary" "$WEB_PORT"
	printf 'Web UI login: username "opencode", password in %s\n' "$WEB_ENV"
	if [[ "$FRONTPAGE" == "1" ]]; then
		printf 'Frontpage:  http://%s:%s/\n' "$primary" "$FRONTPAGE_PORT"
	fi
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
		printf '\nChatGPT browser login page:\n'
		if novnc_available; then
			printf '  http://%s:%s/vnc.html?autoconnect=1&resize=scale\n' "$primary" "$NOVNC_PORT"
			[[ -z "${others// /}" ]] || printf '  (other server IPs: %s)\n' "$others"
			printf '  VNC password: %s\n' "$VNC_PASSWORD"
			printf '  Tunnel if needed: ssh -L %s:127.0.0.1:%s %s@%s\n' \
				"$NOVNC_PORT" "$NOVNC_PORT" "${USER:-user}" "$host"
		else
			printf '  Server IP: %s\n' "$primary"
			printf '  ssh -L 5900:127.0.0.1:5900 %s@%s\n' "${USER:-user}" "$host"
			printf '  connect a VNC client to 127.0.0.1:5900\n'
			printf '  VNC password: %s\n' "$VNC_PASSWORD"
		fi
	fi

	printf '\nGateway management:\n'
	printf '  systemctl --user status free-web-ai-gateway.service   (service mode)\n'
	printf '  systemctl --user restart free-web-ai-gateway.service  (service mode)\n'
	printf '  cd "%s" && bun index.ts status                       (daemon mode)\n' "$INSTALL_DIR"
	printf '\nOpenCode web management:\n'
	printf '  systemctl --user status opencode-web.service\n'
	printf '  systemctl --user restart opencode-web.service\n'
	printf '  cat "%s"\n' "$WEB_ENV"

	if [[ "$FRONTPAGE" == "1" ]]; then
		printf '\nFrontpage management:\n'
		printf '  systemctl --user status pi3b-frontpage.service\n'
		printf '  systemctl --user restart pi3b-frontpage.service\n'
	fi
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

	start_opencode_web

	if [[ "$HEADLESS" == "1" ]]; then
		prepare_headless
	fi

	login_chatgpt
	start_gateway
	verify_gateway
	verify_opencode_web
	install_frontpage
	verify_frontpage
	print_summary
}

main "$@"
