# YouTube Quiz Telegram Bot

This Bun app polls your YouTube watch history page and sends a 3-question free-response quiz to Telegram for newly watched videos. Gemini generates each quiz and also judges every answer.

## What it does

1. Polls each linked user's YouTube history feed using provided cookies on an interval.
2. Filters to videos at least 5 minutes long and watched at least 75%.
3. Generates a 3-question free-response quiz with Gemini from the actual YouTube video URL.
4. Sends quiz questions through Telegram.
5. Uses Gemini again to judge each user answer.
6. Keeps at most 3 active quizzes per user at a time.

## Setup

1. Install dependencies:

```bash
bun install
```

2. Copy `.env.example` to `.env` and fill values.
3. Create a Telegram bot with BotFather and set `TELEGRAM_BOT_TOKEN`.
4. Get a Gemini API key and set `GEMINI_API_KEY`.

## Run

```bash
bun run dev
```

Then in Telegram:

1. Send `/start`
2. Send `/link`
3. Paste your full YouTube Cookie header string.

## Commands

- `/start` registers your Telegram user/chat.
- `/link` asks for a YouTube Cookie header string.
- `/status` shows your active quiz progress.

## Notes and limitation

- Watch-history parsing depends on YouTube page structure and can break when YouTube changes markup.
- Shorts are excluded because only entries with duration `>= 5:00` are accepted.
- Watch percentage is inferred from YouTube thumbnail progress overlays.
- If cookies expire or become invalid, polling notifies the user to re-link with `/link`.
