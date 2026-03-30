# Session Recording & Replay — Full Code Review

**Branch:** `codex/build-plan-in-artifacts` | **35 files, ~9,346 lines added** | **4 commits**
**Reviewer:** Claude Code (Senior Expert Review)
**Date:** 2026-03-25

---

## Maintainer Triage Status (2026-03-25)

This section reflects the current state of the branch after follow-up fixes on top of the original review.

| #   | Status          | Notes                                                                                                                           |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fixed           | Migration logging now uses the structured logger.                                                                               |
| 2   | Fixed           | Replay listener registration now detaches the previous listener before re-registering.                                          |
| 3   | Fixed           | Imported recordings now go through deeper structural validation plus size limits.                                               |
| 4   | Fixed           | Recordings now store metadata in SQLite and write full payloads to hidden app-data files instead of the DB blob column.         |
| 5   | Left to decide  | CDP client/helpers are still duplicated across manual/replay managers.                                                          |
| 6   | Fixed           | CDP-evaluated payload serialization now escapes `\u2028`/`\u2029`; import validation was also strengthened.                     |
| 7   | Left to decide  | Large files remain large; no module split was done in this pass.                                                                |
| 8   | Fixed           | Recording API methods are now non-optional in the renderer contract.                                                            |
| 9   | Fixed           | `loadReplayRuns` now has `try/catch` and updates store error state.                                                             |
| 10  | Not an issue    | Tested and confirmed reachable via `Settings > General`.                                                                        |
| 11  | Fixed           | Manual recording failures now populate store error state; UI no longer silently swallows the path.                              |
| 12  | Fixed           | Parameter type changes now validate against the `RecordingParameter['type']` union.                                             |
| 13  | Fixed           | Privacy email token hashing now uses SHA-256.                                                                                   |
| 14  | Partially fixed | Added an agent-core bundle round-trip test; broader feature coverage is still missing.                                          |
| 15  | Fixed           | Initial parameter draft computation is no longer duplicated on first render.                                                    |
| 16  | Fixed           | Recording list queries now omit step payloads, and the list UI no longer depends on `steps`.                                    |
| 17  | Fixed           | Duplicate recording re-exports were removed from `common/types/index.ts`.                                                       |
| 18  | Fixed           | Manual recording polling errors now trigger teardown/failure instead of silently looping.                                       |
| 19  | Fixed           | Root agent-core API now exports `createRecordingManager()` instead of the class constructor.                                    |
| 20  | Fixed           | `settingsInitialTab` now includes the valid settings-tab union values.                                                          |
| 21  | Fixed           | `recording:delete` now returns the handler result consistently.                                                                 |
| 22  | Fixed           | Detail view now guards the resolved recording id explicitly.                                                                    |
| 23  | Fixed           | CDP-evaluated payload serialization now escapes line and paragraph separators.                                                  |
| 24  | Left to decide  | Dialog/assert actions are still future-scope; replay now throws on unsupported action types rather than silently ignoring them. |

### What Is Still Open

- `#5` duplicated CDP client/helpers are still a maintainability issue.
- `#7` file decomposition is still a maintainability issue.
- `#14` broader tests are still needed if we want the review fully closed.
- `#24` dialog/assert support remains an explicit scope decision, not an accidental omission.

### Recommended Review Focus

If we want to keep pushing this branch before wider review, the highest-value remaining items are:

1. Extract the shared CDP client/helpers.
2. Add broader tests for privacy scrubbing and import validation.
3. Decide whether dialog/assert support belongs in this branch or stays future-phase.

---

## CRITICAL

### 1. `console.log` in production code — `migrations/index.ts`

`packages/agent-core/src/storage/migrations/index.ts:86-116` — Five `console.log` calls in the migrations runner. CLAUDE.md explicitly prohibits this. This ships in the packaged Electron app. Must use the app's structured logger.

### 2. Module-level side-effect with no cleanup — `recording-handlers.ts:11-27`

```ts
let replayEventsRegistered = false;
```

The `replayManager.on('replay:update', ...)` listener is registered once and **never removed**. It broadcasts to `BrowserWindow.getAllWindows()` — a global side-effect that persists forever. If `registerRecordingHandlers` is ever re-invoked (hot reload, test teardown), the boolean guard prevents re-attachment while the IPC `handle()` calls below would silently fail. No corresponding `off()` or `removeAllListeners()` exists.

### 3. Unsafe type cast on imported recordings — `recording-manager.ts:1051-1082`

The `isRecording` type guard (lines 638-651) only checks that `id`, `name`, `createdAt`, `updatedAt` are strings and `steps` is an array. It does **not** validate:

- `steps[n].action.type` is a known action variant
- `steps[n].origin` is `'agent' | 'user'`
- `metadata.source`, `status`, `schemaVersion` are valid

The `as Recording` cast on line 1056 bypasses TypeScript entirely. A crafted `.zip` with malicious selector strings or enormous step arrays will pass the guard and be imported — creating both an injection vector (see #6) and a DoS vector.

### 4. Double serialization bloats SQLite unboundedly — `repositories/recordings.ts:112-148`

The `data` column stores `JSON.stringify(recording)` — the **entire** object including all steps with base64 JPEG screenshots. The top-level columns (`name`, `description`, `source`, etc.) are redundant copies. A 50-step recording with 10 keyframes at ~25KB each means ~250KB of screenshot data stored **twice**. There is no size guard anywhere.

---

## HIGH

### 5. `CdpClient` class fully duplicated in two files

The entire `CdpClient` class (~136 lines), plus `fetchJson`, `resolveBrowserWsEndpoint`, and `evaluateExpression` are copy-pasted identically in both:

- `apps/desktop/src/main/recording/manual-recording-manager.ts` (lines 74-210)
- `apps/desktop/src/main/recording/replay-manager.ts` (lines 48-184)

Any bug fix must be applied twice. Should be extracted to a shared `cdp-client.ts` module.

### 6. Selector injection into CDP `Runtime.evaluate` — `replay-manager.ts:257`

```ts
const selectorsJson = JSON.stringify(selectors ?? []);
return `const selectors = ${selectorsJson};`;
```

Selector values from imported recordings are interpolated into a JavaScript string evaluated via CDP. While `JSON.stringify` prevents most injection, xpath/text selectors from an untrusted `.zip` file could contain payloads that exploit V8 parsing edge cases. Combined with the shallow `isRecording` guard (#3), this is a real attack surface.

### 7. File size violations — 3 files exceed 200-line limit by 5-8x

CLAUDE.md: _"New files must be < 200 lines"_
| File | Lines |
|------|-------|
| `manual-recording-manager.ts` | **1,164** |
| `replay-manager.ts` | **1,410** |
| `recording-manager.ts` | **1,083** |
| `recording-bundle.ts` | **384** |

None qualify for the "generated files, migrations" exception. Each should be decomposed into focused modules (CDP client, privacy pipeline, selector resolver, etc.).

### 8. Recording API methods marked optional when always present — `accomplish.ts:64-82`

All 10+ recording methods (`listReplayRuns?`, `updateRecording?`, `getRecordingPrivacyConfig?`, etc.) are marked optional with `?`. They are unconditionally registered in `recording-handlers.ts` and exposed in `preload/index.ts`. This forces every call site to add nullability guards that are never actually needed, creating dead code branches throughout the store.

### 9. `loadReplayRuns` missing error handling — `recordingStore.ts:92-107`

This is the **only** async store action without a `try/catch`. An IPC error produces an unhandled promise rejection. Every other action in the store (`loadRecordings`, `loadRecording`, `startAgentRecording`, etc.) properly catches errors.

### 10. `RecordingPrivacySection` built but unreachable — `SettingsDialog.tsx`

The `TABS` constant does not include a recording/privacy tab. The component exists (204 lines of UI) but there is no navigation path to reach it. Users cannot configure privacy settings.

### 11. `startManualRecording` failure silently swallowed — `Recordings.tsx:118`

```tsx
void startManualRecording(manualRecordingName.trim() || undefined, ...)
```

The promise is `void`-ed with no `.catch()`. If the CDP browser isn't running or recording is disabled, the error vanishes. The store's `error` state is only populated by `loadRecordings` — the manual recording path never sets it.

### 12. Raw DOM string written to typed union — `RecordingDetail.tsx:433`

```tsx
onChange={(event) => handleParameterDraftChange(parameter.id, 'type', event.target.value)}
```

`event.target.value` is `string` but `RecordingParameter.type` expects `'text' | 'url' | 'email' | 'number' | 'password' | 'file-path'`. No cast guard or validation.

---

## MEDIUM

### 13. SHA-1 for email hash tokens — `recording-manager.ts:94,262`

```ts
crypto.createHash('sha1').update(match).digest('hex').slice(0, 6);
```

SHA-1 is cryptographically broken. Even for display tokens, 6-character SHA-1 truncations are trivially reversible against email dictionaries. Use SHA-256.

### 14. Zero tests for 9,300 lines of new code

No test files exist anywhere for this feature. Critical untested paths:

- `scrubAction` / `scrubString` / `scrubUrl` privacy pipeline
- `createRecordingBundle` / `parseRecordingBundle` ZIP round-trip
- `isRecording` type guard
- `markIncompleteReplayRunsAsFailed` startup logic
- Migration v018/v019 SQL

### 15. `buildInitialParameterDrafts` called twice — `RecordingDetail.tsx:142`

```ts
const [parameterDrafts] = useState(() => buildInitialParameterDrafts(recording));
const [parameterValues] = useState(
  () => buildInitialParameterValues(buildInitialParameterDrafts(recording)), // duplicate
);
```

Iterates `recording.steps` twice on first render. Should `useMemo` once and pass to both.

### 16. Full recording objects loaded for list view — `Recordings.tsx:167`

`listRecordings()` returns full `Recording` objects with all `steps` arrays including base64 screenshots. For a list of 50 recordings, this could be hundreds of MB in memory. The list only needs `metadata.stepCount`, `metadata.durationMs`, etc. — data already available without loading steps.

### 17. Duplicate exports — `common/types/index.ts:130-161`

Both explicit `export type { ... }` (27 named types) and `export * from './recording.js'` are present. Every symbol is exported twice.

### 18. Poll interval swallows CDP errors — `manual-recording-manager.ts:981`

```ts
pollTimer: setInterval(() => {
  void this.flushSessionEvents(session);
}, 250);
```

If the CDP websocket disconnects mid-session, `flushSessionEvents` throws every 250ms silently. No error boundary, no session teardown.

### 19. `RecordingManager` exported as class, not factory — `index.ts:26`

CLAUDE.md: _"Factories are the public API... Do not use internal classes directly; use factories."_ `RecordingManager` is exported directly. The `getRecordingManager()` singleton in `apps/desktop/` partially compensates but the class is still on the public API surface.

### 20. `settingsInitialTab` type out of sync — `Sidebar.tsx:21-23`

The union type is missing `'daemon'`, `'browsers'`, and `'general'` which are valid in `SettingsDialog`. Pre-existing issue but relevant context for the missing `'recordings'` tab.

---

## LOW

### 21. `recording:delete` handler doesn't return result — `recording-handlers.ts:117`

`deleteRecording` call is neither awaited nor returned. Works today (synchronous), but inconsistent with every other handler pattern.

### 22. `recordingId` fallback fragile — `RecordingDetail.tsx:778`

`recordingId ?? selectedRecording.id` — React Router's `useParams()` returns `string | undefined` even on required segments when navigated programmatically with malformed paths.

### 23. Line/paragraph separators in custom privacy keys — `manual-recording-manager.ts:654`

`\u2028`/`\u2029` in user-provided `customSensitiveKeys` are valid JSON but terminate JavaScript lines inside `Runtime.evaluate` expressions. Low risk since it's a controlled CDP sandbox.

### 24. Dialog/assert actions silently ignored in replay

The plan listed dialog capture (alert/confirm/prompt) as a planned action type. The implementation has no `dialog` variant in `RecordingAction`. The plan's implementation note acknowledges this as future work, but the replay engine has no warning when it encounters an unrecognized action — it falls through to the `tool-call` default case silently.

---

## Plan vs Implementation Gap Summary

| Plan Feature                           | Status                                   |
| -------------------------------------- | ---------------------------------------- |
| Agent-driven recording                 | Implemented                              |
| Manual (user-driven) recording via CDP | Implemented                              |
| Privacy scrubbing pipeline             | Implemented (regex-based)                |
| ZIP bundle export/import               | Implemented                              |
| Replay with retry/skip/abort           | Implemented                              |
| Upload replay from file path           | Implemented                              |
| Mixed sessions (agent + user in one)   | **Not implemented**                      |
| Dialog/assert actions                  | **Not implemented**                      |
| Encrypted sharing                      | **Not implemented**                      |
| ML-based PII detection                 | **Not implemented**                      |
| Visual record/replay editor            | **Not implemented** (listed as non-goal) |

---

## Top Recommendations (Priority Order)

1. **Add `isRecording` deep validation** — validate action types, origins, metadata fields, and add size limits before the `as Recording` cast
2. **Extract `CdpClient` to shared module** — eliminate the full class duplication
3. **Split the 1000+ line files** into focused modules (CDP client, privacy pipeline, selector resolver, replay executor, etc.)
4. **Add tests** — at minimum for the privacy scrubbing pipeline and ZIP bundle round-trip
5. **Create a `listRecordingSummaries()` API** that returns metadata without steps/screenshots for the list view
6. **Make recording API methods non-optional** in the `AccomplishAPI` interface
7. **Wire `RecordingPrivacySection` into `SettingsDialog` tabs** — it's built but unreachable
8. **Add error handling to `loadReplayRuns` and `startManualRecording`** call sites
9. **Replace `console.log` with the app logger** in migrations
10. **Replace SHA-1 with SHA-256** for privacy tokens

---

## Severity Summary

| Severity  | Count  |
| --------- | ------ |
| CRITICAL  | 4      |
| HIGH      | 8      |
| MEDIUM    | 8      |
| LOW       | 4      |
| **Total** | **24** |
