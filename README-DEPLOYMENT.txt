free-web-ai: two-container starter

Services
- gateway: builds this repository with the official Bun image and starts `bun run start`.
- browser: builds a small LinuxServer Chromium layer with an HTTPS browser desktop,
  a persistent profile, and a wrapper that guarantees CDP is enabled.

Ports
- Gateway API: host 3457 -> container 3456.
- Browser desktop: host 6081 -> container 3001 (HTTPS, self-signed certificate).
- Chrome CDP: container port 9222 only; it is not published to the host.

Persistent data
- gateway-data stores the gateway's HOME (/config), including its home-directory config/session data.
- browser-data stores Chromium's /config and its separate free-web-ai-profile.
- Chromium startup output and CDP status are written to /config/chromium.log
  inside the browser container.

Setup
1. Put Dockerfile, docker-compose.yml, .dockerignore, and .env.example in the root of the free-web-ai repository.
2. Copy .env.example to .env.
3. Generate two different secrets with `openssl rand -hex 32`; put one in TFG_API_KEY and the other in BROWSER_PASSWORD.
4. Confirm `.env` is ignored by Git before committing anything (`git check-ignore .env`).
5. Run `docker compose config` to validate the Compose file.
6. Run `docker compose up -d --build`.
7. Open `https://<CasaOS-IP>:6081` to access the browser desktop. Accept the self-signed certificate warning on your trusted local network, then sign in with BROWSER_USER/BROWSER_PASSWORD.
8. The gateway API is at `http://<CasaOS-IP>:3457`; use the TFG_API_KEY as its Bearer token.

Security notes
- Do not publish or forward port 9222. It is intentionally not mapped to the host.
- Keep the browser desktop limited to a trusted LAN. Do not expose it directly to the public internet; the desktop provides interactive access to the browser container.
- Keep .env private. Do not commit it.

This only packages the existing gateway and browser. It does not add the planned web management dashboard yet.
