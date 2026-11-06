FROM oven/bun:1

WORKDIR /app

# Keep the source and lockfile in the image; the local .env is excluded by .dockerignore.
COPY --chown=bun:bun . .

ENV HOME=/config \
    TFG_PORT=3456 \
    TFG_CDP_URL=http://browser:9222

USER root
RUN mkdir -p /config && chown bun:bun /config
USER bun

RUN bun install --frozen-lockfile

EXPOSE 3456

CMD ["bun", "run", "start"]
