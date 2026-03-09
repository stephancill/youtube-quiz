# YouTube Quiz Telegram Bot

This Node.js app polls your YouTube watch history page and sends a 5-question free-response quiz to Telegram for newly watched videos. Gemini generates each quiz and also judges every answer.

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
npm install
```

2. Copy `.env.example` to `.env` and fill values.
3. Create a Telegram bot with BotFather and set `TELEGRAM_BOT_TOKEN`.
4. Get a Gemini API key and set `GEMINI_API_KEY`.

## Run

```bash
npm run dev
```

Then in Telegram:

1. Send `/start`
2. Send `/link`
3. Paste your full YouTube Cookie header string.

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

## Running this on OpenClaw heartbeat

You can run the same quiz pipeline in OpenClaw without running a dedicated grammY bot loop.

### 1. Add skill + heartbeat files to your OpenClaw workspace

- `skills/youtube_quiz_openclaw/SKILL.md`
- `HEARTBEAT.md`

### 2. Use the OpenClaw helper script

```bash
npm run openclaw:quiz -- poll
```

Other actions:

```bash
# Save/update cookie header for a user
npm run openclaw:quiz -- link --cookie 'SID=...; HSID=...'

# Check active quiz status
npm run openclaw:quiz -- status

# Submit answer for current question
npm run openclaw:quiz -- answer --answer 'my answer'
```

This OpenClaw flow is optimized for a single user and defaults internal IDs to `1`.
You can still pass `--user-id` and `--chat-id` explicitly if needed.

### 3. Configure OpenClaw heartbeat

In `~/.openclaw/openclaw.json`, configure heartbeat to run on a cadence and deliver alerts:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: { start: "08:00", end: "22:00" }
      }
    }
  }
}
```

### 4. Cookie recovery fallback

If polling fails due to expired YouTube cookies, the OpenClaw skill can recover by using the OpenClaw-managed browser profile:

1. Open `https://www.youtube.com/feed/history` in the `openclaw` browser profile.
2. Have the user sign in manually in that profile.
3. Read cookies and rebuild the cookie header.
4. Run `npm run openclaw:quiz -- link --cookie '...'`.
5. Re-run `npm run openclaw:quiz -- poll`.
