# YouTube Quiz Telegram Bot

This Bun app polls your YouTube watch history page and sends a 5-question free-response quiz to Telegram for newly watched videos. Gemini generates each quiz and also judges every answer.

## What it does

1. Polls each linked user's YouTube history feed using provided cookies on an interval.
2. Filters to videos at least 5 minutes long and watched at least 75%.
3. Generates a 5-question free-response quiz with Gemini from the actual YouTube video URL.
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

## iOS scaffold

This repo also includes an xtool SwiftUI iOS scaffold for capturing YouTube auth through an in-app web view, mirroring the connection flow used in `../no-feed-social`.

```bash
PORT=3000 APPLE_CLIENT_ID=tech.stupid.YoutubeQuiz bun run dev
xtool dev build
```

Open the app, sign in with Apple against the quiz server, then tap **Log in to YouTube**. The app stores the derived YouTube cookie header in Keychain and uploads it to the authenticated server account so the server can validate and poll YouTube.

To restrict iOS access, set `APPLE_EMAIL_WHITELIST` and/or `APPLE_SUBJECT_WHITELIST` to comma-separated allowed Apple relay emails or stable Apple subject IDs. If both are empty, any valid Apple identity for `APPLE_CLIENT_ID` is accepted.

For simulator testing, leave `entitlementsPath` out of `xtool.yml`; xtool's ad-hoc simulator signing can be rejected by launchd when the restricted Sign in with Apple entitlement is present. For physical-device testing, add `entitlementsPath: Entitlements.plist` back after enabling Sign in with Apple on the xtool-created App ID.

## Commands

- `/start` registers your Telegram user/chat.
- `/link` asks for a YouTube Cookie header string.
- `/status` shows your active quiz progress.
- `/stats` shows completed quizzes and aggregate score.
- `/refresh` triggers an immediate history poll for new quizzes.

## Notes and limitation

- Watch-history parsing depends on YouTube page structure and can break when YouTube changes markup.
- Shorts are excluded because only entries with duration `>= 5:00` are accepted.
- Watch percentage is inferred from YouTube thumbnail progress overlays.
- If cookies expire or become invalid, polling notifies the user to re-link with `/link`.

## Continuous polling investigation script

Use this script when you want long-running polling with browser-level auth/session parity (cookies + local/session storage + runtime config) instead of manually replaying just a static `Cookie` header.

1. Start Chrome with remote debugging and a persistent profile, then sign in to YouTube in that Chrome session:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.youtube-quiz-chrome"
```

2. In that Chrome window, confirm `https://www.youtube.com/feed/history` loads as your signed-in history page.

3. Run the investigation poller:

```bash
bun run investigation:history-poll --repeat 30 --interval-ms 60000 --out logs/history-poll.ndjson --state-out logs/history-state.json
```

4. Verify output:

- Console logs should show `auth=true` across iterations.
- `logs/history-poll.ndjson` should contain one JSON line per poll with auth markers, cookies visible to JS, local/session storage keys, selected runtime config, and extracted videos.
- `logs/history-state.json` should contain the latest state snapshot (`requiredState` + `ytConfig`) for quick debugging.

### Captured browser-derived state fields

The script captures and logs these fields each poll to keep request/session parity observable:

- Local/session storage: `DELEGATED_SESSION_ID`, `SESSION_INDEX`, `VISITOR_INFO1_LIVE`, `VISITOR_PRIVACY_METADATA`, `yt-remote-device-id`, `yt-player-headers-readable`.
- Runtime config (`ytcfg`): `INNERTUBE_API_KEY`, `INNERTUBE_CONTEXT_CLIENT_NAME`, `INNERTUBE_CONTEXT_CLIENT_VERSION`, `VISITOR_DATA`, `SESSION_INDEX`, `DELEGATED_SESSION_ID`.
- Cookie visibility: browser-readable cookie names present in `document.cookie`.

## Standalone replay prototype

This script replays the authenticated request path without a live CDP connection during polling. It bootstraps from a previously captured investigation NDJSON file, derives header/template fields, computes `SAPISIDHASH` auth dynamically each request, and merges rolling `Set-Cookie` updates locally.

Run it after you have at least one capture log from `investigation:history-poll`:

```bash
bun run investigation:standalone-replay --source-log logs/history-poll-15m.ndjson --repeat 8 --interval-ms 15000 --out logs/standalone-replay.ndjson --state-out logs/standalone-replay-state.json
```

Optional override if you want to force a cookie bootstrap:

```bash
bun run investigation:standalone-replay --source-log logs/history-poll-15m.ndjson --cookie-header 'SID=...; SAPISID=...; APISID=...'
```

Drift-protection knobs:

- `--rebootstrap-on-auth-failure true` (default): reloads template/cookies from `--source-log` after repeated auth failures.
- `--max-consecutive-auth-failures 2` (default): threshold before re-bootstrap.
- Standalone replay now rolls back to the last known-good in-memory cookie jar on failed iterations to avoid persisting a bad state.

Verification signals:

- `youtubei.status` stays `200`.
- `youtubei.hasSapisidHashAuthorization` is always true.
- `history.looksAuthPage` remains false and `history.videoCountHint` stays above your expected threshold.
