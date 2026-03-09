---
description: Use Node.js + npm conventions for this repo.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to Node.js + npm for runtime and scripts.

- Use `npm install` to install dependencies.
- Use `npm run <script>` for project scripts.
- Use `npx <package> <command>` for one-off tools.

## APIs

- This repo uses `better-sqlite3` for SQLite storage.
- Prefer Node built-ins (`node:fs`, `node:path`, `fetch`) unless a package is already standard in the repo.

## Testing

Use the existing project scripts first.

- Typecheck: `npm run check`
- Format/lint: `npx @biomejs/biome check --write .`

## Runtime

- Dev: `npm run dev`
- Start: `npm run start`
- OpenClaw quiz helper: `npm run openclaw:quiz -- <args>`

Use `tsx` for TypeScript execution in Node where needed.
