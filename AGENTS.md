# AGENTS.md

Quick onboarding guide for contributors working on this repository.

## Project purpose

This app polls a user's YouTube watch history page (via cookie header), detects videos watched past a threshold, and sends Telegram quizzes generated and graded by Gemini.

## Stack

- Runtime/package manager: Bun
- Language: TypeScript
- Bot framework: grammY
- Storage: SQLite via `bun:sqlite`
- LLM: Gemini API (`gemini-2.5-flash`)

## Runbook

1. Install deps:

```bash
bun install
```

2. Create local env file:

```bash
cp .env.example .env.local
```

3. Start app:

```bash
bun run dev
```

4. In Telegram:
   - `/start`
   - `/link`
   - Paste YouTube `Cookie` header string (`name=value; name2=value2; ...`)

## Required env vars

- `TELEGRAM_BOT_TOKEN`
- `GEMINI_API_KEY`

Optional tuning:

- `POLL_INTERVAL_MINUTES`
- `MIN_WATCH_RATIO` (default `0.75`)
- `QUIZ_MAX_HISTORY_ITEMS`
- `DATABASE_PATH`

## Core code map

- `index.ts`: app bootstrap
- `src/bot.ts`: Telegram commands and quiz UX
- `src/poller.ts`: polling scheduler + quiz creation policy
- `src/youtube.ts`: history scraping/parsing and watch-progress extraction
- `src/gemini.ts`: quiz generation + grading requests
- `src/db.ts`: schema and persistence
- `src/types.ts`: shared app types
- `scripts/test-history-parse.ts`: parser smoke test against saved HTML
- `scripts/verify-gemini-video-grounding.ts`: checks whether generated Q/A is grounded in actual video content

## Current product rules

- Only videos with duration `>= 5:00`
- Uses thumbnail progress bar percentage as watch ratio
- Quiz generated only when ratio `>= MIN_WATCH_RATIO`
- Max `3` active quizzes per user
- Free-response questions; Gemini grades user answers
- Quiz intro includes clickable YouTube link

## Contributor workflow

After code changes, always run:

```bash
bunx @biomejs/biome check --write .
bun run check
```

If bot behavior changed, do a manual Telegram smoke test (`/start`, `/link`, answer one quiz question).

## Common pitfalls

- Cookies expire or become invalid: scraper may receive sign-in/consent page. The app notifies users to relink.
- YouTube page structure changes can break parsers in `src/youtube.ts`.
- Gemini quota/rate limits can fail quiz generation.
- Do not commit `.env.local`, DB files, or cookies.

## Safe change guidelines

- Keep parser logic defensive (null checks, multiple renderer shapes).
- Preserve strict JSON parsing/validation around Gemini outputs.
- Prefer small, isolated changes in `src/youtube.ts` and `src/gemini.ts` when debugging data quality.
