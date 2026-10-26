# ScriptSession ensureTunnel flow and UI coordination

## Status
Approved by user 2026-10-26 10:33; implemented using documented invocation API. Baseline VPN preparation committed locally as e2307bf9ccb5f495f49a32ac5103418c1347fd61; do not push GitHub.
This spec supersedes the previous unconditional-startup-UI contract.

## Target behavior
| State | ensureTunnel behavior | UI |
| --- | --- | --- |
| No pairing | Wait for user to save pairing, then prepare/reuse tunnel and return ready | Present or reuse pairing page |
| Paired, no live session | Reuse ready native tunnel, otherwise prepare VPN according to source and connect | No new Loopback page |
| Live session | Verify liveness and return tunnel_open/ready | No new Loopback page |
| Stale session | Clean up own handle and reconnect | No new page when paired |

VPN permission prompts are system UI and are not covered by the promise of no Loopback page. Existing user-opened pages must not be forcibly closed by a service request.

## Verified API constraints
- ScriptSession.call reuses a service or cold-starts index.tsx; serve must be registered within 10 seconds. One serial public handler per script.
- Updated 2026-10-26 10:31: verified Script documentation and Script.invocation declaration. Initial Script.invocation is a frozen snapshot; source is scriptRun/scriptSessionCall/scriptSessionRequest/other, with caller name/env or null. Direct/external launch uses other; do not infer source from caller presence.
- Script.queryParameters is not documented to contain an automatic service-launch marker. Do not assume one.
- Script.onResume(event) carries event.invocation for that specific resume; do not use the initial Script.invocation to classify later resumes. Service handlers use request.source/request.caller for the current request.
- Do not reintroduce a 200ms/500ms timer or shared temporary launch flag as a correctness guarantee.

## Entry strategy — B now supported by documented API
The earlier A compromise is superseded. Native API prerequisite for B is available; no timing window or second script is needed.
- Register service and resume listener synchronously first.
- Classify scriptSessionCall/scriptSessionRequest as service invocations. Initial service launch does not independently present UI, regardless of pairing state; ensureTunnel itself handles missing pairing. Therefore status/releaseTunnel cold starts stay headless even when unpaired.
- Initial other/scriptRun invocation opens normal UI, preserving manual launch behavior. scriptRun is an explicit policy to show UI for non-service invocation, not proof of a human caller.
- In onResume use event.invocation.source: service resume does not open UI, other/scriptRun resume opens/reuses normal UI.
- Caller metadata is diagnostic context, not authentication or permission; never trust queryParameters.caller as native identity.
- Service ensureTunnel opens/reuses pairing UI only if pairing is missing. Pairing success signals the awaiting service immediately; page may stay open.
- Reuse the same UI coordinator across initial launch, manual resume and service-requested pairing.

## Pairing/UI coordinator
kit/presentation.ts owns one presentation promise (covering opening/open/closed state) and a bounded pairing wait operation. index.tsx bridges the coordinator to Navigation and Keychain; PairingPage supports an optional root close button.
- Set presentation guard before invoking Navigation.present; clear it in finally even on errors.
- If a page is already visible, reuse it instead of presenting another modal.
- Pairing page and import action signal completion only AFTER savePairing succeeds; no secret record crosses service boundary.
- The service must resolve its pairing wait on successful save, not wait for the user to close UI.
- On success re-read Keychain, then deviceHub.get(); newly paired verification may already have opened a session, so reuse it.
- Closing UI without saved pairing resolves not_paired/ready:false. A pairing attempt failure may remain on screen for retry until cancelled or timed out.
- Use bounded pairing wait (proposed 120 seconds); clean event subscribers and timers on success/cancel/error/timeout. Tell caller to use at least 180000ms total timeout.
- If a still-running native pairing operation completes after timeout, it may save pairing, but do not continue the timed-out workflow to open a tunnel. A later ensureTunnel can use it.
- Caller timeout cannot cancel accepted work; do not promise cancellation detection that ScriptSession does not provide.

## Service handler
1. Validate command. status remains side-effect-free (no VPN start or service-requested UI); releaseTunnel releases only own handle.
2. ensureTunnel: no pairing -> await coordinator pairing outcome -> if no successful saved pairing return not_paired.
3. await deviceHub.get(): check liveness, attach ready native tunnel, or create new session with VPN preparation.
4. Return JSON tunnel_open/ready:true, or error/ready:false. Never return credentials or native handles.
5. Public requests are serial. Pairing wait blocks queued status/release requests, so it must be bounded and documented. Do not poll this same service for pairing progress while a request is awaiting pairing.

## Scope and safety
- One Loopback script only; no home tab branches, no Script.exit on UI dismissal.
- Keep VPN source policy and no-stop cleanup contract from 06-32 spec.
- Do not change client ownership or Keychain-only security model.
- Update README in both languages to match selected entry strategy, timeout and queue behavior.
- No GitHub push. New implementation gets a separate local commit only when requested/approved.

## Validation matrix
- Warm and cold starts for unpaired/paired/live/stale states.
- Pair success returns ready while UI remains open; import success works the same way.
- Closing without pairing returns not_paired; failure/retry and pairing timeout clean subscriptions.
- Two UI requests yield one presentation; resume while visible does not duplicate.
- Paired cold ensureTunnel does not call Navigation.present.
- Unpaired cold status/releaseTunnel does not present UI or start VPN.
- A service-started instance later resumed manually opens UI; a manually-started instance later resumed by service does not reopen closed UI. Always classify resumes by event.invocation, not Script.invocation.
- Initial other/scriptRun opens UI even with an existing pairing; service sources stay headless except ensureTunnel requesting pairing.
- builtIn starts VPN only when creating a new session; proxyApp never controls it.
- Existing live session does not start VPN; stale session reconnects.
- No token/record leakage; diagnostics and mock tests; real UI cold-start acceptance requires runtime testing.

## Handoff
Implementation complete in working script. Initial source uses Script.invocation.source, resume uses event.invocation.source. Pairing onChanged signals after saved PIN/import; ensureTunnel awaits it and re-reads pairing before deviceHub.get(). Service-requested UI opens directly on PairingPage; existing root UI is reused. No Script.exit, no timing heuristic.

## Validation evidence (2026-10-26)
- Full Loopback TypeScript diagnostics: no issues, including new invocation properties.
- tests/presentation.ts: 9/9 passed — source classification, presentation deduplication, save resolves before UI closes, visible page reuse, reopen after close, cancel without pairing, bounded wait, late save available to next call, present failure cleanup.
- tests/vpn.ts: 6/6 passed — previous VPN preparation regression suite.
- Tests use injected presentation/VPN mocks, do not actually pair or alter VPN. Actual UI cold-start, native resume routing, manual PIN/import and physical device connection still require live acceptance; do not claim mock tests prove them.
- README.md and README-zh.md updated for source policy, pairing wait, serial queue and timeout caveats.
- No new Git commit or GitHub push in this implementation task. Local baseline commit preserved.

## Remaining constraints
- A pairing operation/validation already started by UI is not cancelled by service wait timeout; the service does not itself proceed to deviceHub.get() after a timed-out wait. UI-owned native validation may still complete.
- When a normal page is already open, the request reuses it; user follows its Pair Device link rather than forcing a second modal over it.
