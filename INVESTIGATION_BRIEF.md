# YouTube Watch History Continuous Polling Investigation Brief

## Objective

Build a script that continuously polls `https://www.youtube.com/feed/history` and remains authenticated over long-running sessions.

## Required Output

1. A runnable script (Bun/TypeScript) that can continuously poll the watch history page without becoming unauthenticated.
2. The script may use browser-exported state, including cookies and local/session storage.
3. The script may use local Chrome state and Chrome MCP automation/inspection as part of the solution.
4. Include a repeatable setup/run procedure and verification steps.

## Repository Context

- Runtime/tooling: Bun + TypeScript.
- Current history fetch path: `src/youtube.ts`.
- Poll scheduler: `src/poller.ts`.
- Cookie persistence: `src/db.ts`, `src/types.ts`.
- Manual fetch tester: `scripts/test-history-fetch.ts`.

Relevant files:

- `src/youtube.ts`
- `src/poller.ts`
- `scripts/test-history-fetch.ts`
- `src/db.ts`
- `src/types.ts`
- `src/bot.ts`

## Current Implementation Notes

1. Cookie input from `/link` is parsed into a cookie jar and persisted.
2. Each fetch builds `Cookie` header from jar entries.
3. Response `Set-Cookie` values are parsed and merged back into the jar.
4. Safety guards currently in place:
   - Skip persistence on auth/consent-like responses.
   - Skip persistence when critical auth cookies are deleted.
5. Diagnostics currently emitted on auth/consent responses:
   - status, URL, title, marker booleans, `Set-Cookie` names.

## Reproduction and Observed Behavior

Command used for long-run test:

```bash
bun run test:history-fetch --repeat 30 --interval-ms 60000
```

Observed pattern:

1. Repeated successful iterations with cookie updates:
   - `updated_names=VISITOR_INFO1_LIVE,VISITOR_PRIVACY_METADATA,SIDCC,__Secure-1PSIDCC,__Secure-3PSIDCC`
2. Later failure iteration emits:
   - `[youtube-auth-diagnostic] ... has_signin=true has_service_login=true ...`
   - `status=200` on `/feed/history`
   - `set_cookie_names` includes core session/auth cookie names.
3. Script throws:
   - `YouTube cookies appear expired or invalid. Please run /link and paste a fresh Cookie header.`

## Bundle-Level Signals to Investigate

The YouTube JS bundles contain request-time auth/session logic beyond static cookie replay.

### Bundle references

1. Player bundle (example discovered during investigation):
   - `/s/player/<id>/player_ias.vflset/<locale>/base.js`
2. Main app bundle (discovered from homepage):
   - `https://www.youtube.com/s/_/ytmainappweb/_/js/k=ytmainappweb.kevlar_base.../m=kevlar_base_module,kevlar_main_module`

### Identifiers and behaviors found in minified bundle searches

1. Cookie-derived auth header generation:
   - `SAPISIDHASH`, `APISIDHASH`, `Authorization`
2. Request headers/context:
   - `X-Goog-AuthUser`, `X-Goog-PageId`, `X-Origin`, `X-YouTube-Client-Name`, `X-YouTube-Client-Version`
3. InnerTube context/config usage:
   - `INNERTUBE_API_KEY`, `INNERTUBE_API_VERSION`, `INNERTUBE_CONTEXT`, `VISITOR_DATA`
4. Token/session flows:
   - `gapi.auth.getToken`, `LOGIN_INFO`, session stickiness/session storage markers
5. Cookie/session telemetry hooks:
   - high-frequency cookie rotation related metrics/hooks

### Helpful extraction command used

```bash
curl -Ls 'https://www.youtube.com/s/_/ytmainappweb/_/js/k=ytmainappweb.kevlar_base.en_US.d5Q_Sh18DeQ.es5.O/am=AAAAAQAAAgk/d=1/rs=AGKMywG-sO5mZm982kt19lbC102uER1KLQ/m=kevlar_base_module,kevlar_main_module' \
  | rg 'SAPISIDHASH|APISIDHASH|X-Goog-AuthUser|X-Goog-PageId|Authorization|LOGIN_INFO|VISITOR_DATA|INNERTUBE_CONTEXT|gapi\.auth|getToken|cookie|ServiceLogin'
```

## Investigation Scope

Produce an implementation that replicates all request-time state needed to keep watch-history polling authenticated for continuous operation.

Allowed state inputs:

1. Cookies from local Chrome profile.
2. Local storage and session storage exports from active YouTube browser session.
3. Additional browser-derived request metadata/state values required by YouTube request paths.

Allowed tooling:

1. Chrome MCP for browser automation and state extraction.
2. Local Chrome profile/state access where appropriate.
3. Existing Bun/TypeScript stack in this repository.

## Suggested Investigation Workstreams

1. **State capture parity**
   - Enumerate cookie names, local storage keys, session storage keys, and runtime config values involved in authenticated history fetch.
2. **Request parity**
   - Capture and replay full browser request envelope for `/feed/history` and related preflight/navigation context.
3. **Session continuity**
   - Identify rolling tokens/cookies that must be refreshed and their refresh triggers.
4. **Automation path**
   - Use Chrome MCP to drive authenticated page access and extract state updates continuously.
5. **Reliability test harness**
   - Run 30+ minute and multi-hour polling trials with structured diagnostics.

## Acceptance Criteria

1. Continuous polling run completes without unauthenticated transitions over target test window.
2. Script handles rolling auth state updates automatically.
3. Script includes clear setup docs for obtaining and refreshing required browser state.
4. Script emits diagnostics sufficient to debug any auth transition quickly.

## Deliverables

1. New script file(s) implementing continuous authenticated polling.
2. README section with setup and execution instructions.
3. Logged evidence from a successful long-running test.
4. Notes mapping which browser-derived state fields were required.
