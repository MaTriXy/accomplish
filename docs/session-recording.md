# Session Recording & Replay

Session Recording & Replay lets Accomplish capture browser workflows as structured action logs and replay them later in a fresh browser page.

This is not video capture. A recording is an ordered list of browser actions, selector strategies, replay options, and privacy metadata. That makes recordings compact, editable, exportable, and suitable for reuse across runs and machines.

## What the feature does

- Captures browser workflows from agent-driven runs and manual browser sessions
- Stores recordings locally and keeps replay history attached to each recording
- Scrubs sensitive values before they are persisted
- Lets you inspect steps, add parameters, and replay the workflow with different values
- Exports and imports recordings as ZIP bundles by default, with legacy JSON import support

## What gets recorded

Accomplish records actions, not pixels. Depending on how the session was created, a recording can include:

- Navigation events
- Clicks
- Fill and type actions
- Select changes
- Hover events
- Scroll events
- Keypress steps
- Wait steps inferred from browser operations
- Tool-call summaries for browser operations that do not map cleanly to a more specific action
- Selector fallbacks such as `css`, `xpath`, `ref`, `text`, `aria-label`, `aria-role`, and `test-id`
- Optional scrubbed screenshot keyframes on manual recordings
- Optional target snapshots for manual steps
- Privacy annotations describing what was redacted

## What does not get recorded

- Raw network request or response bodies
- File contents from uploads
- Cookies, session tokens, or auth headers as first-class payloads
- Full video recordings
- Native desktop-control actions outside the browser workflow

## Current implementation scope

The feature is implemented across the Accomplish desktop shell, web UI, and `@accomplish_ai/agent-core`.

Today, the shipped behavior is:

- Agent recordings can be started from the execution page with `Record steps`
- Manual recordings can be started from the `Recordings` page and run against the visible dev-browser Chrome window
- Manual recordings can attach scrubbed JPEG keyframes for `navigate`, `click`, `fill`, and `select` steps when screenshot capture is enabled
- Replays run in a fresh dev-browser page and support pause, resume, cancel, and step-by-step mode
- Replays support upload steps when the recording provides file-path parameters for them
- Replay history is persisted locally

Known limitations:

- Screenshot keyframes are currently captured for manual recordings only
- Shared upload steps still require the recipient to provide valid local file paths at replay time
- Recordings are browser-only; desktop-control sessions are out of scope

## How to use it

### 1. Configure recording privacy

Open `Settings` and use the `Session Recording` section to control:

- Whether recording is enabled at all
- Whether agent reasoning text is stored
- Whether emails, secrets, or URL query parameters are redacted
- Whether all form inputs should be redacted
- Whether manual screenshot keyframes should be captured
- Whether screenshots should blur the full viewport or only masked regions
- Maximum screenshot width and height
- Custom sensitive keys used for URL redaction and field classification

### 2. Record an agent-driven workflow

1. Start or open a task in the execution view.
2. Click `Record steps`.
3. Let the agent perform the browser workflow.
4. Click `Stop recording` when you want to finalize the recording.
5. Open the finished recording from the `Recordings` page.

Agent recordings are useful when you want to preserve what the browser tool already did during a task.

### 3. Record a manual browser workflow

1. Open the `Recordings` page from the sidebar.
2. In `Manual browser recording`, optionally enter:
   - A recording name
   - A start URL
3. Click `Start manual recording`.
4. Interact with the visible dev-browser Chrome window.
5. Return to Accomplish and click `Stop manual recording`.

Manual recording is useful for capturing a workflow by hand before parameterizing or replaying it.

### 4. Inspect and edit a recording

Open a recording from the `Recordings` page to:

- Review the step list
- See selector fallbacks
- View manual screenshot keyframes
- Inspect privacy annotations
- Rename the recording
- Add a description and tags
- Define parameters and default values

### 5. Replay a recording

From the recording detail page:

1. Review or edit parameter values.
2. Set replay speed.
3. Choose the step timeout.
4. Choose error handling:
   - `Abort`
   - `Skip`
   - `Retry`
5. Click `Replay Recording`.

For upload steps, fill the generated file-path parameter with an absolute path on the current machine. Use one path per line when a step uploads multiple files.

You can also:

- Pause a running replay
- Resume a paused replay
- Cancel a replay
- Set speed to `0` and use step-by-step replay

## Replay behavior

Replay runs in a clean dev-browser page and uses selector fallbacks in order. The current replay path supports:

- `navigate`
- `click`
- `fill`
- `type`
- `select`
- `hover`
- `scroll`
- `wait`
- `keypress`
- `upload`

The runner also includes:

- Multiple selector strategies for resilience
- Click coordinate fallback
- Wait handling for visible, hidden, navigation, network-idle, and custom conditions
- Modifier-aware keyboard replay
- Configurable retry-on-error replay
- Replay history persisted per recording

## Data payloads

The canonical payload types live in `packages/agent-core/src/common/types/recording.ts`.

### Recording

```json
{
  "id": "rec_123",
  "schemaVersion": 1,
  "name": "Checkout smoke test",
  "description": "Covers login, cart, and checkout",
  "status": "completed",
  "metadata": {
    "source": "user",
    "sourceTaskId": null,
    "durationMs": 42137,
    "stepCount": 12,
    "startUrl": "https://example.com/login",
    "viewport": { "width": 1280, "height": 720 },
    "userAgent": "Accomplish Recording",
    "appVersion": "0.4.0",
    "platform": "darwin"
  },
  "steps": [],
  "privacyManifest": {
    "configSnapshot": {
      "enabled": true,
      "recordAgentReasoning": true,
      "redactEmails": true,
      "redactSecrets": true,
      "redactUrlQueryParams": true,
      "redactAllFormInputs": false,
      "captureScreenshots": true,
      "blurAllScreenshots": false,
      "maxScreenshotWidth": 960,
      "maxScreenshotHeight": 540,
      "customSensitiveKeys": ["token", "auth", "password"]
    },
    "redactions": []
  },
  "parameters": [],
  "tags": ["qa", "checkout"],
  "createdAt": "2026-03-25T09:00:00.000Z",
  "updatedAt": "2026-03-25T09:05:00.000Z"
}
```

### Recording step

```json
{
  "index": 3,
  "id": "step_456",
  "timestampMs": 11840,
  "action": {
    "type": "fill",
    "value": "[EMAIL_a1b2c3]",
    "clearFirst": true
  },
  "selectors": [
    { "type": "css", "value": "input[name=\"email\"]", "confidence": 0.95 },
    {
      "type": "aria-role",
      "value": "{\"role\":\"textbox\",\"name\":\"Email\"}",
      "confidence": 0.88
    }
  ],
  "screenshot": "<base64 jpeg, optional>",
  "targetSnapshot": {
    "role": "textbox",
    "name": "Email",
    "tagName": "input",
    "attributes": {
      "name": "email",
      "type": "email"
    },
    "boundingBox": {
      "x": 320,
      "y": 214,
      "width": 420,
      "height": 40
    }
  },
  "pageUrl": "https://example.com/login",
  "privacyAnnotations": [
    { "type": "email", "path": "action.value", "replacement": "[EMAIL_a1b2c3]" },
    { "type": "custom", "path": "screenshot", "replacement": "[SCREENSHOT_MASKED_1]" }
  ],
  "origin": "user"
}
```

### Replay run

```json
{
  "id": "replay_789",
  "recordingId": "rec_123",
  "recordingName": "Checkout smoke test",
  "status": "paused",
  "currentStepIndex": 4,
  "totalSteps": 12,
  "startedAt": "2026-03-25T09:10:00.000Z",
  "updatedAt": "2026-03-25T09:10:14.000Z",
  "options": {
    "speed": 0,
    "parameters": {
      "user_email": "qa@example.com",
      "upload_step_5": "/Users/example/fixtures/invoice.pdf"
    },
    "errorStrategy": "abort",
    "stepTimeoutMs": 15000,
    "maxRetries": 2
  },
  "currentStep": {
    "index": 4,
    "stepId": "step_457",
    "actionType": "click",
    "pageUrl": "https://example.com/cart"
  }
}
```

## Privacy model

Privacy rules are applied before data is persisted.

The current pipeline includes:

- Email redaction
- Secret-like value redaction
- URL query parameter redaction based on configured sensitive keys
- Selector-aware form-field classification
- Paranoid `redactAllFormInputs` mode
- Manual screenshot masking for sensitive form fields
- Optional full-frame screenshot blur

The privacy manifest stores:

- The privacy config snapshot used during recording
- The list of recorded redactions and replacements

## Local storage

Recordings and replay runs are stored locally, but they do not use the same storage layout.

At a high level:

- Recording metadata is persisted in the `recordings` table
- Full recording payloads are stored as JSON files under a hidden `.recordings/` directory inside Accomplish app data
- Replay history is persisted in the `replay_runs` table
- Recording privacy settings are persisted in `recording_privacy_config`

In practice, that means:

- SQLite stays small and fast for listing and indexing recordings
- Large step payloads and screenshot-bearing recordings live on disk instead of inside the main DB row
- Deleting a recording removes both the DB row and the corresponding payload directory
- Exported bundles are still derived from the canonical `Recording` payload, not from a separate share-only format

The exported bundle is derived from the same `Recording` payload used internally.

## How sharing works

There is no cloud sync in the current implementation. Sharing is done with explicit export and import.

### Export a recording

1. Open the `Recordings` page.
2. Find the recording you want to share.
3. Click `Export`.
4. Save the file as `*.accomplish-recording.zip`.

ZIP is now the default sharing format because it can hold the core recording plus extra assets such as screenshots and future attachments in a single file.

### Import a recording

1. Open the `Recordings` page.
2. Click `Import`.
3. Select a previously exported `*.zip` or legacy `*.json` recording file.
4. Accomplish adds it to the local library as a new recording.

### Bundle structure

A recording bundle uses a ZIP container with a stable payload and optional extra files:

```text
checkout-smoke-test-2026-03-25T09-05-00Z-7f3a2c1d.accomplish-recording.zip
├── manifest.json
├── recording.json
└── screenshots/
    ├── step-0003-step_456.jpg
    └── step-0007-step_460.jpg
```

The default filename includes:

- a slugified recording name
- the recording creation timestamp
- a short stable ID suffix

### Bundle manifest

`manifest.json` describes the exported bundle instance, not just the recording payload.

Example:

```json
{
  "bundleVersion": 1,
  "bundleId": "b7b9d1f4-3a6d-4f69-8d91-2f7d3f0cc123",
  "exportedAt": "2026-03-25T09:12:00.000Z",
  "recordingSchemaVersion": 1,
  "originalRecordingId": "7f3a2c1d-8d17-4af3-8dd0-6aa1c0fa2f55",
  "files": [
    {
      "path": "recording.json",
      "sha256": "4d8c...",
      "size": 8241
    }
  ],
  "screenshots": [
    {
      "stepId": "step_456",
      "path": "screenshots/step-0003-step_456.jpg",
      "sha256": "aa91...",
      "size": 18452
    }
  ]
}
```

### What is preserved when shared

- Recording steps
- Selectors
- Parameters
- Privacy annotations
- Manual screenshots that were already scrubbed
- Replay-ready metadata

### What changes on import

When a recording is imported:

- A new recording ID is assigned locally
- The original recording ID is preserved in metadata for provenance
- The bundle ID is preserved in metadata when the import source was a ZIP bundle
- `sourceTaskId` is cleared
- A recording that was still marked `recording` is normalized to `completed`
- New `createdAt` and `updatedAt` timestamps are assigned

### Sharing recommendations

- Treat exported recordings as workflow artifacts, not secrets
- Review the step list before sharing if the flow touched private data
- Use `redactAllFormInputs` for highly sensitive workflows
- Prefer disabling screenshots or enabling full-frame blur when the workflow handles confidential content
- Share the target site, environment, and required test accounts alongside the recording so replay succeeds on the recipient machine

## Portability notes

Recordings are designed to be portable, but replay still depends on the destination environment.

A shared recording works best when:

- The target site structure is similar
- The recipient has access to the same application or staging environment
- Required files, accounts, and credentials exist on the destination machine
- Parameters are filled in with values valid for that environment

## Related surfaces in the app

- `Execution` page: start and stop agent recordings
- `Recordings` page: manual recording, import, export, and library view
- `Recording detail` page: metadata, parameters, screenshots, and replay controls
- `Settings`: recording privacy configuration
