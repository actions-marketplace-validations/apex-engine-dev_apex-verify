# Run `reallydone verify` inside a container: generated checks and your tests then run in an isolated filesystem
# (and, with --network none, without network access). Build from the repository root:
#   docker build -f docker/Dockerfile -t reallydone .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git patch python3 python3-pip python3-pytest ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/reallydone
COPY . .
RUN npm install --no-audit --no-fund --loglevel=error && npm link >/dev/null
# Your project is mounted at /work; the container user cannot write outside it and /tmp.
RUN git config --system --add safe.directory '*' && useradd -m reallydone && mkdir -p /work && chown reallydone /work
USER reallydone
WORKDIR /work
ENTRYPOINT ["reallydone", "verify"]
