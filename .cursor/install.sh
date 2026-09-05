#!/usr/bin/env bash
# Cloud Agent install: bring a fresh checkout to the state `pnpm dev` expects.
#
# Everything here is idempotent and durable, so it is safe to re-run and safe to bake into
# an environment-build snapshot. Per-boot processes (the dev servers) live in `terminals`
# in environment.json, not here — a server started in install would either block the build
# or be lost when a new pod boots from the snapshot.
set -euo pipefail
cd "$(dirname "$0")/.."

# The lockfile is the source of truth; never let install rewrite it (README: the pinned
# wrangler version is load-bearing, and a global/looser copy silently overrides the config).
corepack pnpm install --frozen-lockfile

# Local dev needs exactly one secret — BETTER_AUTH_SECRET — and none of the OAuth pairs; a
# social provider without credentials is simply not offered (README: Auth). Generate it once
# and leave any existing .dev.vars untouched, so re-running install never rotates the secret
# out from under a running Worker (which does not hot-reload .dev.vars).
if [ ! -f apps/api/.dev.vars ]; then
  cp apps/api/.dev.vars.example apps/api/.dev.vars
  secret="$(openssl rand -base64 32)"
  # `|` delimiter because a base64 secret can contain `/` and `+`.
  sed -i "s|BETTER_AUTH_SECRET=replace-me|BETTER_AUTH_SECRET=${secret}|" apps/api/.dev.vars
fi

# Create the local D1 (SQLite under .wrangler) from migrations. Wrangler records what it has
# applied, so a second run is a no-op rather than an error.
corepack pnpm migrate:local

# `wrangler dev` requires the [assets] directory (../web/dist) to exist at startup, so the
# API server cannot come up on a fresh checkout until the SPA has been built once. The Vite
# dev server on :5173 is what actually serves the SPA in development; this build exists only
# to satisfy that binding, and `vite build` overwrites it cleanly on every run.
corepack pnpm build
