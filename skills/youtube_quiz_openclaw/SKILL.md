---
name: youtube_quiz_openclaw
description: Manage YouTube watch-history quizzes via OpenClaw heartbeat and chat messages.
---

# YouTube Quiz OpenClaw Skill

Use this skill to run the YouTube quiz workflow in OpenClaw instead of a dedicated Telegram bot process.

## Commands to run

- Link/update a user cookie:

```bash
npm run openclaw:quiz -- link --cookie '<youtube_cookie_header>'
```

- Check status:

```bash
npm run openclaw:quiz -- status
```

- Poll for newly eligible watched videos (heartbeat should run this):

```bash
npm run openclaw:quiz -- poll
```

- Submit an answer:

```bash
npm run openclaw:quiz -- answer --answer '<free_form_answer>'
```

For single-user setups, `--user-id` and `--chat-id` are optional and default to `1`.

## Required behavior

1. Parse JSON from script stdout.
2. For `poll` output:
   - For each `events[]` item, send `intro`, then send `question`.
   - For each `errors[]` item, send an error notice to that `chatId` asking the user to relink cookies.
3. For `status` and `answer`, send the `message` text back to the requesting chat.
4. If `poll` returns no events and no errors, reply exactly `HEARTBEAT_OK`.

## Cookie auto-recovery on poll failure

If a `poll` error indicates expired/invalid cookies or auth failure, recover automatically:

1. Start host browser profile and open YouTube history:

```bash
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://www.youtube.com/feed/history
```

2. Ask the user to manually sign in inside the OpenClaw browser profile.
3. Read cookies from the browser profile:

```bash
openclaw browser --browser-profile openclaw cookies --json
```

4. Build a cookie header string from YouTube/Google auth cookies (`name=value; ...`) and run:

```bash
npm run openclaw:quiz -- link --cookie '<rebuilt_cookie_header>'
```

5. Re-run poll once:

```bash
npm run openclaw:quiz -- poll
```

If login is still incomplete, send a short message asking the user to finish sign-in in the OpenClaw browser and retry.

## Heartbeat guidance

- Heartbeat should call `poll` and only send messages when there are events/errors.
- During normal chat turns:
  - If user asks to link, collect cookie header and call `link`.
  - If user asks for progress, call `status`.
  - If there is an active quiz and user provides an answer, call `answer`.
