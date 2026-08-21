# Unbent

A personal note app that keeps your notes in Markdown and hands them back whenever you ask.

Notes are Markdown with YAML frontmatter. Attachments are ordinary files. Export produces a
plain folder tree — one directory per note, containing `note.md` and a `files/` subdirectory —
that you can read, grep, and back up without this app existing.

## Why

Evernote's owner gave a lot of people a reason to leave. Leaving should be easy, and staying
should never depend on it being hard.

## Stack

- **Cloudflare Pages** — SPA hosting
- **Cloudflare Workers** + Hono — API
- **Cloudflare D1** (SQLite) — note text, metadata, FTS5 full-text search
- **Cloudflare R2** — attachment blobs
- **Better Auth** — OAuth (Google, GitHub)
- **Vite + React + CodeMirror 6** — Markdown editor with live preview

Workers Paid ($5/mo) is required: the free tier's 10ms CPU limit cannot run import or export.

## Layout

```
apps/web       Vite + React SPA
apps/api       Hono API on Workers
packages/shared  zod schemas, frontmatter codec, remark plugins
packages/enex    ENEX -> Markdown, runtime-agnostic
```

## Development

```bash
pnpm install
pnpm migrate:local
pnpm dev
```

The SPA runs on :5173 and proxies `/api/*` to the Worker on :8787, so sessions are same-origin
and there is no CORS in development.

## Backups

`wrangler d1 export` is broken on databases containing FTS5 tables — it fails and leaves the
database wedged. Do not run it. The zip export at `/api/export` is the backup mechanism.
