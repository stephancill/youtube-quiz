# Implementation Notes

## 2026-05-15 - iOS client scaffold and auth

- Added an xtool SwiftPM iOS client alongside the existing Bun Telegram bot.
- The app target is `YouTubeQuiz`, with shared Swift code in `YouTubeQuizCore`.
- The client uses the same non-persistent `WKWebView` cookie-capture pattern as `../no-feed-social` connection views, pointed at `https://www.youtube.com/feed/history`.
- YouTube cookies are converted to the semicolon-separated cookie header format the existing scraper already accepts.
- The iOS app stores the captured YouTube credentials and server session in Keychain through `KeychainCredentialStore`.

## Server auth API

- Added Sign in with Apple server auth at `POST /auth/apple`.
- The server validates Apple identity tokens against Apple's JWKS endpoint, checks issuer, expiry, and `APPLE_CLIENT_ID`, then creates a random app session token.
- Optional `APPLE_EMAIL_WHITELIST` and `APPLE_SUBJECT_WHITELIST` env vars restrict which Apple identities can create app sessions; leaving both empty keeps local/dev access open.
- Session tokens are stored hashed in SQLite.
- Added `PUT /youtube/cookies`, protected by the app session bearer token.
- Cookie upload parses the cookie header, validates it through the existing `YoutubeService.validateCookieJar`, then stores the validated jar against the standalone app user.
- Telegram `/link` still works through the bot path; cookie-header parsing is shared in `src/cookies.ts`.

## Current product gap

- Standalone app users can sign in and upload YouTube cookies.
- The iOS app gates users through Apple sign-in, then YouTube connection, then a quiz home screen.
- The quiz home screen calls the protected `GET /quizzes` API and lists rows from `app_quizzes`.
- The poller now includes app-linked users and creates `app_quizzes`; first-run app polling initializes a baseline from the newest fetched history item instead of generating quizzes for old watch history.

## YouTube auth and parsing notes

- The embedded YouTube login WebView uses an iPhone Safari user agent. A desktop Chrome/macOS user agent in `WKWebView` triggered Google's insecure-browser sign-in block.
- The app now uploads only YouTube-domain cookies for this flow. Uploading both Google and YouTube domains as a flattened `Cookie` header can corrupt same-name auth cookies because the server receives no domain/path metadata.
- The server keeps the first value when an uploaded header contains duplicate cookie names, matching browser cookie header ordering more closely than overwriting later values.
- Server-side YouTube validation fetches `https://m.youtube.com/feed/history` directly. Starting at `www.youtube.com/feed/history` redirects to mobile for the app's iPhone Safari user agent, and manually supplied `Cookie` headers are brittle across that cross-origin redirect.
- After switching validation to the mobile origin, a fresh app upload validated successfully with 23 captured cookies and parsed 124 eligible history videos.
- The history parser supports mobile YouTube history HTML where `ytInitialData` is emitted as an escaped string and videos appear as `compactVideoRenderer` entries.

## Apple signing and xtool notes

- Registered bundle ID work ended up involving two identifiers:
  - The intended app ID: `tech.stupid.YoutubeQuiz`.
  - xtool-created device install ID: `XTL-6JKMV57Y77.tech.stupid.YoutubeQuiz`.
- Sign in with Apple must be enabled on the xtool-created identifier for real-device installs that include the entitlement.
- `Entitlements.plist` contains `com.apple.developer.applesignin = Default`.
- For physical-device testing, add this to `xtool.yml`:

```yaml
entitlementsPath: Entitlements.plist
```

- For simulator testing, leave `entitlementsPath` out of `xtool.yml`. With xtool's ad-hoc simulator signing, the restricted Sign in with Apple entitlement caused launchd to reject the app before Swift started.
- Current xtool simulator support only installs the app (`simctl install`) and returns; it does not launch the simulator app. A manual `xcrun simctl launch booted tech.stupid.YoutubeQuiz` is needed to verify launch behavior.
- The simulator failure looked like an immediate crash, but logs showed:

```text
Security policy issue
Launchd job spawn failed
```

- Removing `entitlementsPath`, reinstalling, and launching via `simctl` confirmed the simulator app runs.
- Reproduced again on 2026-05-15: with `entitlementsPath: Entitlements.plist`, the installed simulator app contains `com.apple.developer.applesignin = Default`, and manual launch fails with `FBSOpenApplicationServiceErrorDomain` / `RBSRequestErrorDomain` wrapping `NSPOSIXErrorDomain Code=163` (`Security policy issue`, `Launchd job spawn failed`). Without `entitlementsPath`, `simctl launch` succeeds and returns a PID.

## Verified commands

These passed after the scaffold and auth work:

```bash
bunx @biomejs/biome check --write .
bun run check
swiftformat Sources/ Tests/
swift test
xtool dev build
xtool dev run --simulator --no-attach --no-logs --launch-timeout 420
```

Real-device install also succeeded after enabling Sign in with Apple on `XTL-6JKMV57Y77.tech.stupid.YoutubeQuiz`; the only launch failure observed at that point was from the iPhone locking before launch.
