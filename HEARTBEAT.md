# YouTube Quiz Heartbeat

- Run `npm run openclaw:quiz -- poll`.
- For every `events[]` item, send intro then first question to the related chat.
- For auth/cookie errors, try cookie auto-recovery via OpenClaw browser profile, then rerun poll.
- If recovery still fails, send a relink/sign-in message to that chat.
- If output has no events and no errors, return `HEARTBEAT_OK`.
