FROM lscr.io/linuxserver/chromium:latest

COPY wrapped-chromium /usr/bin/wrapped-chromium
COPY custom-cont-init.d/10-fix-chromium.sh /custom-cont-init.d/10-fix-chromium.sh

RUN chmod +x /usr/bin/wrapped-chromium /custom-cont-init.d/10-fix-chromium.sh
