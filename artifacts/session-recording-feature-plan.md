# Session Recording & Replay — Feature Plan

**Project:** Accomplish Desktop Agent
**Repository:** https://github.com/MaTriXy/accomplish
**Author:** AI-Generated Feature Plan
**Date:** 2026-03-24
**Status:** Draft / Proposal

**Implementation note (2026-03-25):** The shipped implementation now uses ZIP-based `.accomplish-recording.zip` bundles for sharing, includes retry/skip/abort replay handling, supports upload replay through file-path parameters, and stores recording metadata in SQLite while persisting full payloads as hidden local files. Mixed sessions, dialog/assert actions, encrypted sharing, and other advanced flows remain future-phase work.

---

## Implementation Status Snapshot (2026-03-25)

### Implemented on branch

- Agent-driven recording
- Manual user-driven browser recording via CDP/dev-browser
- Privacy scrubbing for text, URLs, form values, and screenshot masking
- Recording detail UI with metadata editing and parameter editing
- Replay engine with pause, resume, step mode, retry, skip, and abort
- Upload replay through file-path parameters
- ZIP bundle export/import with manifest, provenance, and externalized screenshots
- Replay/run persistence and startup cleanup for interrupted runs
- Settings UI for recording/privacy configuration

### Implemented follow-up hardening

- Deeper imported-recording validation
- File-size and storage-size guards
- Non-optional renderer IPC contract for recording APIs
- Error handling for replay history and manual recording start failures
- Safer CDP payload serialization for evaluated scripts
- Metadata-only recording list loading to avoid shipping full step payloads into the list view
- File-backed local recording payload storage with SQLite metadata rows

### Still left / future-phase

- Mixed agent + user sessions in a single recording
- Dialog/assert action capture and replay
- Encrypted sharing bundles
- ML-based or richer PII classification beyond current rules/hints
- Multi-tab flows, branching, loops, and visual assertions
- CLI/CI replay flows

### Review-cleanup items still left to decide

- Extract the duplicated CDP client/helpers into a shared module
- Split the very large recording-related files into smaller modules
- Expand automated test coverage beyond the initial bundle round-trip test

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Recording Architecture](#2-recording-architecture)
3. [Privacy & Scrubbing Pipeline](#3-privacy--scrubbing-pipeline)
4. [Replay Engine](#4-replay-engine)
5. [Recording Format & Schema](#5-recording-format--schema)
6. [Integration Points](#6-integration-points)
7. [MVP Scope & Phasing](#7-mvp-scope--phasing)
8. [Cross-Machine Sharing (Post-MVP)](#8-cross-machine-sharing-post-mvp)
9. [Appendix: Edge Cases & Open Questions](#9-appendix-edge-cases--open-questions)

---

## 1. Executive Summary

Session Recording & Replay enables users to capture browser-based workflows — whether driven by the AI agent or performed manually — and replay them on demand. Recordings are action-level event logs (not pixel-level screen captures), making them compact, portable, parameterizable, and privacy-safe. The system integrates deeply with the existing Playwright/CDP infrastructure already present in the dev-browser MCP tool while introducing a new privacy scrubbing pipeline to ensure no personal data leaks into recording files.

### Goals

- Record any browser session (agent-driven or user-driven) as a structured action log
- Replay recordings with resilient selector strategies and smart wait conditions
- Scrub PII before it reaches the recording file — never store raw sensitive data
- Keep recordings compact (JSON action log + optional keyframe screenshots)
- Enable future cross-machine sharing via encrypted, portable `.accomplish-recording` files

### Non-Goals (MVP)

- Full video recording or pixel-level replay
- Recording of desktop-control (non-browser) actions
- Cloud sync or collaborative editing of recordings
- Visual record/replay editor (drag-and-drop action reordering)

---

## 2. Recording Architecture

### 2.1 What Gets Recorded

Recordings capture **actions**, not pixels. Each recorded step represents a discrete user or agent interaction:

| Action Category     | Captured Data                                                            | Source                                                                  |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Navigation**      | URL, referrer, navigation type (goto, back, forward, reload)             | CDP `Page.frameNavigated`, Playwright `page.goto()`                     |
| **Click**           | Target selector(s), coordinates, button (left/right/middle), click count | CDP `Input.dispatchMouseEvent`, Playwright `page.click()`               |
| **Type / Fill**     | Target selector(s), text value (pre-scrubbed), key events                | CDP `Input.dispatchKeyEvent`, Playwright `page.fill()`                  |
| **Scroll**          | Target selector or viewport, delta X/Y, final scroll position            | CDP `Input.dispatchMouseEvent` (wheel), Playwright `page.mouse.wheel()` |
| **Select**          | Target selector, selected option value(s)                                | Playwright `page.selectOption()`                                        |
| **Hover**           | Target selector, coordinates                                             | Playwright `page.hover()`                                               |
| **File Upload**     | Target selector, file name(s) (not contents), MIME types                 | Playwright `page.setInputFiles()`                                       |
| **Wait**            | Condition type (network idle, selector visible, timeout), duration       | Inferred from inter-action gaps                                         |
| **Dialog**          | Type (alert/confirm/prompt), message, response                           | CDP `Page.javascriptDialogOpening`                                      |
| **Page snapshot**   | Accessibility tree snapshot (compact), viewport dimensions               | Playwright `page.accessibility.snapshot()`                              |
| **Screenshot**      | Base64 JPEG keyframe (optional, at configurable moments)                 | Existing `ScreencastController`                                         |
| **Agent tool call** | Tool name, sanitized input, output summary                               | `TaskCallbacks.onToolUse`, `onToolCallComplete`                         |
| **Agent reasoning** | Reasoning text (if user opts in)                                         | `TaskCallbacks.onReasoning`                                             |

### 2.2 What Does NOT Get Recorded

- Raw network request/response bodies (too large, privacy risk)
- Cookie values, auth tokens, session IDs
- File contents for uploads (only metadata)
- Passwords or credit card numbers (scrubbed before recording)
- Full DOM snapshots (too large; compact accessibility snapshots instead)

### 2.3 Data Model

```typescript
// packages/agent-core/src/recording/types.ts

export interface Recording {
  /** Unique recording ID (UUID v4) */
  id: string;

  /** Schema version for forward compatibility */
  schemaVersion: number; // starts at 1

  /** Human-readable name */
  name: string;

  /** User-provided description */
  description?: string;

  /** Recording metadata */
  metadata: RecordingMetadata;

  /** Ordered list of recorded actions */
  steps: RecordingStep[];

  /** Privacy manifest — what was redacted */
  privacyManifest: PrivacyManifest;

  /** Parameterized variables for replay customization */
  parameters: RecordingParameter[];

  /** Tags for organization */
  tags: string[];

  /** Creation timestamp (ISO 8601) */
  createdAt: string;

  /** Last modified timestamp */
  updatedAt: string;
}

export interface RecordingMetadata {
  /** Source: 'agent' | 'user' | 'mixed' */
  source: 'agent' | 'user' | 'mixed';

  /** Original task ID if agent-driven */
  sourceTaskId?: string;

  /** Duration of original session in ms */
  durationMs: number;

  /** Total step count */
  stepCount: number;

  /** Starting URL */
  startUrl: string;

  /** Browser viewport at recording time */
  viewport: { width: number; height: number };

  /** User agent string */
  userAgent: string;

  /** Accomplish version */
  appVersion: string;

  /** OS platform */
  platform: string;
}

export interface RecordingStep {
  /** Step index (0-based) */
  index: number;

  /** Unique step ID */
  id: string;

  /** Timestamp relative to recording start (ms) */
  timestampMs: number;

  /** Action type */
  action: RecordingAction;

  /** Multiple selector strategies for resilience */
  selectors?: SelectorStrategy[];

  /** Optional keyframe screenshot (base64 JPEG, scrubbed) */
  screenshot?: string;

  /** Accessibility snapshot of target element */
  targetSnapshot?: ElementSnapshot;

  /** Page URL at time of action */
  pageUrl: string;

  /** Privacy annotations for this step */
  privacyAnnotations?: PrivacyAnnotation[];

  /** Whether this step came from agent or user */
  origin: 'agent' | 'user';

  /** Agent context (if agent-driven) */
  agentContext?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reasoning?: string;
  };
}

export type RecordingAction =
  | { type: 'navigate'; url: string; navigationType: 'goto' | 'back' | 'forward' | 'reload' }
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount: number }
  | { type: 'fill'; value: string; clearFirst: boolean }
  | { type: 'type'; text: string; delay?: number }
  | { type: 'keypress'; key: string; modifiers: string[] }
  | { type: 'select'; values: string[] }
  | { type: 'scroll'; deltaX: number; deltaY: number; target: 'viewport' | 'element' }
  | { type: 'hover' }
  | { type: 'upload'; fileNames: string[]; mimeTypes: string[] }
  | { type: 'wait'; condition: WaitCondition; durationMs: number }
  | { type: 'tool-call'; toolName: string; outputSummary?: string };

export interface SelectorStrategy {
  /** Strategy type, ordered by preference */
  type: 'css' | 'xpath' | 'text' | 'aria-label' | 'aria-role' | 'test-id' | 'nth-match';

  /** The selector string */
  value: string;

  /** Confidence score (0-1) based on uniqueness at recording time */
  confidence: number;
}

export interface WaitCondition {
  type: 'networkIdle' | 'selectorVisible' | 'selectorHidden' | 'timeout' | 'navigation' | 'custom';
  value?: string; // selector or timeout ms
  timeoutMs: number;
}

export interface ElementSnapshot {
  role: string;
  name: string;
  tagName: string;
  innerText?: string;
  attributes: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
}
```

### 2.4 How Browser Actions Are Captured

#### Agent-Driven Sessions

For agent-driven sessions, the existing architecture already captures all the data needed. The flow:

1. **TaskManager** (`packages/agent-core/src/internal/classes/TaskManager.ts`) spawns OpenCode CLI via `OpenCodeAdapter`
2. **OpenCodeAdapter** (`packages/agent-core/src/internal/classes/OpenCodeAdapter.ts`) parses stdout and emits events
3. The dev-browser MCP tool executes Playwright commands — each tool call is captured via `TaskCallbacks.onToolUse` and `TaskCallbacks.onToolCallComplete`
4. **New:** A `RecordingInterceptor` hooks into these callbacks to build `RecordingStep[]`

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ TaskManager  │───▶│ OpenCodeAdapter  │───▶│ StreamParser     │
│              │    │  (node-pty)      │    │  (stdout→events) │
└─────────────┘    └──────────────────┘    └────────┬─────────┘
                                                     │
                          ┌──────────────────────────┤
                          ▼                          ▼
                   ┌─────────────────┐    ┌───────────────────┐
                   │ TaskCallbacks   │    │ BrowserFrame      │
                   │ .onToolUse()    │    │ .onBrowserFrame() │
                   │ .onToolCallEnd()│    │ (screencast JPEG) │
                   └────────┬────────┘    └────────┬──────────┘
                            │                      │
                            ▼                      ▼
                   ┌──────────────────────────────────────────┐
                   │         RecordingInterceptor (NEW)       │
                   │  - Converts tool calls → RecordingStep[] │
                   │  - Captures screenshots at key moments   │
                   │  - Runs privacy scrubbing pipeline       │
                   │  - Generates selector strategies         │
                   └──────────────────────────────────────────┘
```

**Tool Call Mapping** (dev-browser MCP tools → RecordingAction):

| MCP Tool              | RecordingAction                                                   |
| --------------------- | ----------------------------------------------------------------- |
| `browser_goto`        | `{ type: 'navigate', url, navigationType: 'goto' }`               |
| `browser_click`       | `{ type: 'click', x, y, button, clickCount }`                     |
| `browser_type`        | `{ type: 'fill', value, clearFirst }` or `{ type: 'type', text }` |
| `browser_scroll`      | `{ type: 'scroll', deltaX, deltaY }`                              |
| `browser_select`      | `{ type: 'select', values }`                                      |
| `browser_hover`       | `{ type: 'hover' }`                                               |
| `browser_wait`        | `{ type: 'wait', condition }`                                     |
| `browser_snapshot`    | Captured as `ElementSnapshot` context, not a step                 |
| `browser_file_upload` | `{ type: 'upload', fileNames, mimeTypes }`                        |

#### User-Driven Sessions (Manual Recording)

For user-driven sessions, we need to inject CDP event listeners to capture raw user interactions. This requires a new `UserSessionRecorder` class:

```typescript
// packages/agent-core/src/recording/user-session-recorder.ts

export class UserSessionRecorder {
  private cdpSession: CDPSession;
  private steps: RecordingStep[] = [];
  private startTime: number;

  async startRecording(context: BrowserContext, page: Page): Promise<void> {
    this.cdpSession = await context.newCDPSession(page);
    this.startTime = Date.now();

    // Enable CDP domains for user interaction capture
    await this.cdpSession.send('DOM.enable');
    await this.cdpSession.send('Input.setInterceptDrags', { enabled: true });
    await this.cdpSession.send('Overlay.setInspectMode', {
      mode: 'captureAreaScreenshot', // for element identification
      highlightConfig: { showInfo: true },
    });

    // Listen for navigation
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.recordNavigation(frame.url());
      }
    });

    // Listen for console-injected interaction events
    await this.injectInteractionTracker(page);

    // Listen for dialogs
    page.on('dialog', (dialog) => {
      this.recordDialog(dialog);
    });
  }

  private async injectInteractionTracker(page: Page): Promise<void> {
    // Inject a script that posts messages for user interactions
    await page.evaluateOnNewDocument(`
      (function() {
        const observer = {
          handleEvent(e) {
            const target = e.target;
            const selector = computeSelector(target); // CSS + XPath + text
            const data = {
              type: e.type,
              selector,
              x: e.clientX,
              y: e.clientY,
              key: e.key,
              value: target.value,
              tagName: target.tagName,
              role: target.getAttribute('role'),
              ariaLabel: target.getAttribute('aria-label'),
              testId: target.getAttribute('data-testid'),
              timestamp: Date.now()
            };
            window.__accomplishRecorder?.push(data);
          }
        };

        window.__accomplishRecorder = [];
        ['click', 'input', 'change', 'keydown', 'scroll'].forEach(evt => {
          document.addEventListener(evt, observer, { capture: true, passive: true });
        });

        function computeSelector(el) {
          // Returns { css, xpath, text, ariaLabel, testId, nthMatch }
          // Implementation in section 4.3
        }
      })();
    `);

    // Poll the recorder buffer periodically
    this.pollInterval = setInterval(async () => {
      const events = await page.evaluate(() => {
        const buf = window.__accomplishRecorder || [];
        window.__accomplishRecorder = [];
        return buf;
      });
      for (const event of events) {
        this.processUserEvent(event);
      }
    }, 100); // 100ms polling interval
  }
}
```

#### Mixed Sessions

When an agent-driven task includes moments where the user takes over (e.g., responding to an `ask-user-question` prompt by interacting with the browser), the recording marks each step's `origin` field as either `'agent'` or `'user'`. The `RecordingInterceptor` detects user takeover by monitoring for raw CDP input events that don't correspond to any tool call.

### 2.5 Storage

Recordings are stored in two forms:

1. **SQLite** (primary, for the recording library UI) — metadata + action log stored as JSON in a TEXT column
2. **File export** (`.accomplish-recording`) — a single JSON file, optionally gzipped, for sharing

Screenshot keyframes are stored as base64 JPEG strings within the step objects. At 50% quality and 640×360 resolution, each keyframe is roughly 15–30 KB. With one keyframe per navigation event, a 50-step recording with 10 page loads adds ~200 KB of screenshot data.

---

## 3. Privacy & Scrubbing Pipeline

Privacy is the most critical subsystem. The scrubbing pipeline runs **inline during recording** — sensitive data never reaches the recording file, not even transiently.

### 3.1 Architecture

```
Raw Action Data
      │
      ▼
┌─────────────────────────────────────────────────┐
│              Privacy Scrubbing Pipeline          │
│                                                  │
│  ┌─────────────┐   ┌──────────────────────┐     │
│  │ Form Field  │   │ Regex Pattern Engine │     │
│  │ Classifier  │──▶│ (PII detection)      │     │
│  └─────────────┘   └──────────┬───────────┘     │
│                               │                  │
│  ┌─────────────┐   ┌─────────▼────────────┐     │
│  │ URL         │   │ Content Redactor     │     │
│  │ Sanitizer   │──▶│ (value replacement)  │     │
│  └─────────────┘   └──────────┬───────────┘     │
│                               │                  │
│  ┌─────────────┐   ┌─────────▼────────────┐     │
│  │ Screenshot  │   │ Privacy Manifest     │     │
│  │ Scrubber    │──▶│ Generator            │     │
│  └─────────────┘   └──────────┬───────────┘     │
│                               │                  │
└───────────────────────────────┼──────────────────┘
                                ▼
                     Scrubbed RecordingStep
```

### 3.2 PII Detection & Redaction

```typescript
// packages/agent-core/src/recording/privacy/pii-detector.ts

export interface PIIMatch {
  type: PIIType;
  value: string;
  startIndex: number;
  endIndex: number;
  confidence: number; // 0-1
  redactedValue: string;
}

export type PIIType =
  | 'email'
  | 'password'
  | 'credit-card'
  | 'phone'
  | 'ssn'
  | 'address'
  | 'name'
  | 'date-of-birth'
  | 'ip-address'
  | 'api-key'
  | 'auth-token'
  | 'custom';

export class PIIDetector {
  private patterns: Map<PIIType, RegExp[]> = new Map([
    ['email', [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g]],
    [
      'credit-card',
      [
        /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
        /\b[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g,
      ],
    ],
    [
      'phone',
      [
        /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
        /\b\+?[0-9]{1,4}[-.\s]?[0-9]{2,4}[-.\s]?[0-9]{3,4}[-.\s]?[0-9]{3,4}\b/g,
      ],
    ],
    ['ssn', [/\b[0-9]{3}[-\s]?[0-9]{2}[-\s]?[0-9]{4}\b/g]],
    [
      'api-key',
      [
        /\b(?:sk|pk|api|key|token|secret|bearer)[-_]?[a-zA-Z0-9]{20,}\b/gi,
        /\bghp_[a-zA-Z0-9]{36}\b/g, // GitHub PAT
        /\bsk-[a-zA-Z0-9]{32,}\b/g, // OpenAI key
        /\bxoxb-[a-zA-Z0-9-]+\b/g, // Slack token
      ],
    ],
    [
      'auth-token',
      [
        /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, // JWT
      ],
    ],
    [
      'ip-address',
      [
        /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
      ],
    ],
  ]);

  /** Custom patterns from user configuration */
  private customPatterns: { name: string; pattern: RegExp }[] = [];

  detect(text: string): PIIMatch[] {
    const matches: PIIMatch[] = [];
    for (const [type, regexes] of this.patterns) {
      for (const regex of regexes) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            type,
            value: match[0],
            startIndex: match.index,
            endIndex: match.index + match[0].length,
            confidence: this.computeConfidence(type, match[0]),
            redactedValue: this.redact(type, match[0]),
          });
        }
      }
    }
    return this.deduplicateOverlapping(matches);
  }

  private redact(type: PIIType, value: string): string {
    switch (type) {
      case 'email':
        return `[EMAIL_${this.hash(value).slice(0, 6)}]`;
      case 'credit-card':
        return `[CC_****${value.slice(-4)}]`;
      case 'phone':
        return `[PHONE_****${value.slice(-4)}]`;
      case 'ssn':
        return `[SSN_REDACTED]`;
      case 'password':
        return `[PASSWORD_REDACTED]`;
      case 'api-key':
        return `[API_KEY_REDACTED]`;
      case 'auth-token':
        return `[TOKEN_REDACTED]`;
      case 'ip-address':
        return `[IP_REDACTED]`;
      default:
        return `[REDACTED]`;
    }
  }

  private hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
```

### 3.3 Form Field Classification

Beyond regex-based PII detection, the scrubber classifies HTML form fields by their semantic type to catch values that regex might miss:

```typescript
// packages/agent-core/src/recording/privacy/form-classifier.ts

export class FormFieldClassifier {
  private sensitiveTypes = new Set([
    'password',
    'credit-card',
    'cc-number',
    'cc-exp',
    'cc-csc',
    'cc-name',
    'cc-type',
  ]);

  private sensitiveAutocomplete = new Set([
    'cc-number',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year',
    'cc-csc',
    'cc-name',
    'cc-type',
    'new-password',
    'current-password',
    'one-time-code',
    'transaction-amount',
  ]);

  private sensitiveNamePatterns = [
    /passw(or)?d/i,
    /secret/i,
    /credit.?card/i,
    /card.?num/i,
    /cvv|cvc|csc/i,
    /expir/i,
    /ssn|social.?sec/i,
    /tax.?id/i,
    /routing.?num/i,
    /account.?num/i,
    /pin/i,
    /security.?code/i,
  ];

  classify(element: ElementSnapshot): FieldSensitivity {
    // Check input type
    if (element.attributes['type'] === 'password') {
      return { sensitive: true, reason: 'input-type-password', autoRedact: true };
    }

    // Check autocomplete attribute
    const autocomplete = element.attributes['autocomplete'];
    if (autocomplete && this.sensitiveAutocomplete.has(autocomplete)) {
      return { sensitive: true, reason: `autocomplete-${autocomplete}`, autoRedact: true };
    }

    // Check name/id/placeholder patterns
    const nameFields = [
      element.attributes['name'],
      element.attributes['id'],
      element.attributes['placeholder'],
      element.attributes['aria-label'],
    ].filter(Boolean);

    for (const field of nameFields) {
      for (const pattern of this.sensitiveNamePatterns) {
        if (pattern.test(field!)) {
          return { sensitive: true, reason: `name-match-${pattern.source}`, autoRedact: true };
        }
      }
    }

    return { sensitive: false, reason: 'none', autoRedact: false };
  }
}
```

### 3.4 Screenshot Scrubbing

When keyframe screenshots are captured, sensitive regions are blurred before storage:

```typescript
// packages/agent-core/src/recording/privacy/screenshot-scrubber.ts

export class ScreenshotScrubber {
  /**
   * Blurs rectangular regions of a JPEG screenshot.
   * Uses sharp (already a common Electron dep) for image processing.
   */
  async scrub(
    screenshotBase64: string,
    sensitiveRegions: BoundingBox[],
    blurRadius: number = 20,
  ): Promise<string> {
    const buffer = Buffer.from(screenshotBase64, 'base64');
    let image = sharp(buffer);
    const metadata = await image.metadata();

    // For each sensitive region, extract, blur, and composite back
    const composites: sharp.OverlayOptions[] = [];

    for (const region of sensitiveRegions) {
      const blurred = await sharp(buffer)
        .extract({
          left: Math.round(region.x),
          top: Math.round(region.y),
          width: Math.round(region.width),
          height: Math.round(region.height),
        })
        .blur(blurRadius)
        .toBuffer();

      composites.push({
        input: blurred,
        left: Math.round(region.x),
        top: Math.round(region.y),
      });
    }

    const result = await image.composite(composites).jpeg({ quality: 50 }).toBuffer();
    return result.toString('base64');
  }
}
```

Sensitive regions are identified by:

1. All password-type input fields (bounding box from the accessibility snapshot)
2. All fields classified as sensitive by `FormFieldClassifier`
3. Custom user-marked regions (persisted in recording settings)

### 3.5 URL Parameter Sanitization

```typescript
// packages/agent-core/src/recording/privacy/url-sanitizer.ts

export class URLSanitizer {
  private sensitiveParams = new Set([
    'token',
    'access_token',
    'refresh_token',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'password',
    'secret',
    'session_id',
    'sessionid',
    'sid',
    'key',
    'private_key',
    'client_secret',
    'code',
    'state',
    'nonce', // OAuth params
  ]);

  sanitize(url: string): { sanitized: string; redacted: string[] } {
    try {
      const parsed = new URL(url);
      const redacted: string[] = [];

      for (const [key, value] of parsed.searchParams.entries()) {
        if (this.sensitiveParams.has(key.toLowerCase()) || this.looksLikeToken(value)) {
          redacted.push(key);
          parsed.searchParams.set(key, `[REDACTED]`);
        }
      }

      // Also strip hash fragments that look like tokens
      if (parsed.hash && this.looksLikeToken(parsed.hash)) {
        redacted.push('#fragment');
        parsed.hash = '#[REDACTED]';
      }

      return { sanitized: parsed.toString(), redacted };
    } catch {
      return { sanitized: url, redacted: [] };
    }
  }

  private looksLikeToken(value: string): boolean {
    // High entropy strings > 20 chars are likely tokens
    return value.length > 20 && this.shannonEntropy(value) > 3.5;
  }

  private shannonEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const c of str) freq.set(c, (freq.get(c) || 0) + 1);
    return [...freq.values()].reduce((sum, count) => {
      const p = count / str.length;
      return sum - p * Math.log2(p);
    }, 0);
  }
}
```

### 3.6 Configurable Privacy Rules

Users can define custom scrubbing rules via a settings UI:

```typescript
export interface PrivacyConfig {
  /** Master enable/disable for recording */
  recordingEnabled: boolean;

  /** Auto-redact all form inputs (paranoid mode) */
  redactAllFormInputs: boolean;

  /** Capture screenshots during recording */
  captureScreenshots: boolean;

  /** Blur all screenshots (maximum privacy) */
  blurAllScreenshots: boolean;

  /** Custom field selectors to always redact */
  customSensitiveSelectors: string[];

  /** Custom regex patterns to detect and redact */
  customPIIPatterns: { name: string; pattern: string }[];

  /** Domains to never record */
  excludedDomains: string[];

  /** Record agent reasoning text */
  recordAgentReasoning: boolean;

  /** Maximum screenshot resolution */
  maxScreenshotWidth: number;
  maxScreenshotHeight: number;
}
```

### 3.7 Privacy Manifest

Every recording includes a manifest documenting exactly what was redacted and why:

```typescript
export interface PrivacyManifest {
  /** Privacy config used during recording */
  configSnapshot: PrivacyConfig;

  /** Summary of all redactions */
  redactions: RedactionEntry[];

  /** Total PII instances detected */
  totalPIIDetected: number;

  /** Total screenshots scrubbed */
  totalScreenshotsScrubbed: number;

  /** Domains visited */
  domainsVisited: string[];

  /** Scrubbing pipeline version */
  pipelineVersion: string;
}

export interface RedactionEntry {
  stepIndex: number;
  field: string; // which field was redacted (e.g., 'action.value', 'pageUrl')
  piiType: PIIType;
  reason: string;
}
```

---

## 4. Replay Engine

### 4.1 Architecture

The Replay Engine takes a `Recording` and re-executes its steps using Playwright, with intelligent handling of dynamic content, timing variations, and errors.

```
┌───────────────────────────────────────────────────────┐
│                    ReplayEngine                        │
│                                                        │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ StepRunner │  │ SelectorResolver │  │ WaitStrategy  │  │
│  │            │──│ (multi-fallback) │──│ (adaptive)    │  │
│  └─────┬──────┘  └──────────────┘  └───────────────┘  │
│        │                                               │
│  ┌─────▼──────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ ErrorRecov │  │ Parameterizer│  │ SpeedControl  │  │
│  │ ery Engine │  │ (variable    │  │ (1x,2x,step)  │  │
│  │            │  │  substitution)│  │               │  │
│  └────────────┘  └──────────────┘  └───────────────┘  │
│                                                        │
│  ┌─────────────────────────────────────────────────┐   │
│  │               ReplayCallbacks                    │   │
│  │  onStepStart, onStepComplete, onStepError,      │   │
│  │  onPause, onResume, onComplete, onScreenshot    │   │
│  └─────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

### 4.2 Replay Execution

```typescript
// packages/agent-core/src/recording/replay/replay-engine.ts

export interface ReplayOptions {
  /** Playback speed multiplier (1 = original timing) */
  speed: number; // 0 = step-by-step, 0.5, 1, 2, 5, 10

  /** Whether to pause before each step (step-by-step mode) */
  stepByStep: boolean;

  /** Parameter overrides */
  parameters: Record<string, string>;

  /** Error handling strategy */
  errorStrategy: 'retry' | 'skip' | 'abort';

  /** Maximum retries per step */
  maxRetries: number;

  /** Timeout per step (ms) */
  stepTimeout: number;

  /** Viewport override (null = use recording viewport) */
  viewport?: { width: number; height: number } | null;

  /** Capture screenshots during replay for comparison */
  captureReplayScreenshots: boolean;
}

export class ReplayEngine {
  private state: ReplayState = 'idle';
  private currentStepIndex: number = 0;
  private pausePromise: { resolve: () => void } | null = null;

  async replay(
    recording: Recording,
    page: Page,
    options: ReplayOptions,
    callbacks: ReplayCallbacks,
  ): Promise<ReplayResult> {
    this.state = 'running';
    const results: StepResult[] = [];

    // Set viewport to match recording
    const viewport = options.viewport ?? recording.metadata.viewport;
    await page.setViewportSize(viewport);

    for (let i = 0; i < recording.steps.length; i++) {
      if (this.state === 'cancelled') break;
      if (this.state === 'paused') await this.waitForResume();

      this.currentStepIndex = i;
      const step = recording.steps[i];
      callbacks.onStepStart?.(i, step);

      // Apply parameter substitution
      const resolvedStep = this.parameterize(step, recording.parameters, options.parameters);

      // Wait for inter-step timing (adjusted by speed)
      if (i > 0 && options.speed > 0) {
        const delay = (step.timestampMs - recording.steps[i - 1].timestampMs) / options.speed;
        await this.sleep(Math.min(delay, 5000)); // cap at 5s per gap
      }

      // Step-by-step pause
      if (options.stepByStep) {
        this.state = 'paused';
        callbacks.onPause?.(i, step);
        await this.waitForResume();
      }

      // Execute with retry logic
      const result = await this.executeStepWithRetry(page, resolvedStep, options, callbacks);
      results.push(result);

      callbacks.onStepComplete?.(i, step, result);

      if (!result.success && options.errorStrategy === 'abort') {
        break;
      }
    }

    this.state = 'idle';
    return {
      recording: recording.id,
      success: results.every((r) => r.success || r.skipped),
      stepsTotal: recording.steps.length,
      stepsSucceeded: results.filter((r) => r.success).length,
      stepsFailed: results.filter((r) => !r.success && !r.skipped).length,
      stepsSkipped: results.filter((r) => r.skipped).length,
      results,
      durationMs: Date.now() - results[0]?.startedAt || 0,
    };
  }

  private async executeStepWithRetry(
    page: Page,
    step: RecordingStep,
    options: ReplayOptions,
    callbacks: ReplayCallbacks,
  ): Promise<StepResult> {
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        await this.executeStep(page, step, options);
        return {
          success: true,
          stepIndex: step.index,
          startedAt: Date.now(),
          attempts: attempt + 1,
        };
      } catch (error) {
        if (attempt < options.maxRetries && options.errorStrategy === 'retry') {
          await this.sleep(1000 * (attempt + 1)); // exponential-ish backoff
          continue;
        }

        if (options.errorStrategy === 'skip') {
          return {
            success: false,
            skipped: true,
            stepIndex: step.index,
            error: (error as Error).message,
            startedAt: Date.now(),
            attempts: attempt + 1,
          };
        }

        return {
          success: false,
          skipped: false,
          stepIndex: step.index,
          error: (error as Error).message,
          startedAt: Date.now(),
          attempts: attempt + 1,
        };
      }
    }
    // Should not reach here
    return {
      success: false,
      skipped: false,
      stepIndex: step.index,
      error: 'Max retries exceeded',
      startedAt: Date.now(),
      attempts: options.maxRetries + 1,
    };
  }

  private async executeStep(
    page: Page,
    step: RecordingStep,
    options: ReplayOptions,
  ): Promise<void> {
    const { action } = step;

    switch (action.type) {
      case 'navigate':
        if (action.navigationType === 'goto') {
          await page.goto(action.url, {
            waitUntil: 'domcontentloaded',
            timeout: options.stepTimeout,
          });
        } else if (action.navigationType === 'back') {
          await page.goBack({ timeout: options.stepTimeout });
        } else if (action.navigationType === 'forward') {
          await page.goForward({ timeout: options.stepTimeout });
        } else {
          await page.reload({ timeout: options.stepTimeout });
        }
        break;

      case 'click': {
        const locator = await this.resolveSelector(page, step.selectors!);
        await locator.click({
          button: action.button,
          clickCount: action.clickCount,
          timeout: options.stepTimeout,
        });
        break;
      }

      case 'fill': {
        const locator = await this.resolveSelector(page, step.selectors!);
        if (action.clearFirst) await locator.clear();
        await locator.fill(action.value, { timeout: options.stepTimeout });
        break;
      }

      case 'type': {
        const locator = await this.resolveSelector(page, step.selectors!);
        await locator.pressSequentially(action.text, {
          delay: action.delay ?? 50,
          timeout: options.stepTimeout,
        });
        break;
      }

      case 'keypress':
        await page.keyboard.press(
          action.modifiers.length > 0 ? `${action.modifiers.join('+')}+${action.key}` : action.key,
        );
        break;

      case 'select': {
        const locator = await this.resolveSelector(page, step.selectors!);
        await locator.selectOption(action.values, { timeout: options.stepTimeout });
        break;
      }

      case 'scroll':
        if (action.target === 'viewport') {
          await page.mouse.wheel(action.deltaX, action.deltaY);
        } else {
          const locator = await this.resolveSelector(page, step.selectors!);
          await locator.evaluate((el, { dx, dy }) => el.scrollBy(dx, dy), {
            dx: action.deltaX,
            dy: action.deltaY,
          });
        }
        break;

      case 'hover': {
        const locator = await this.resolveSelector(page, step.selectors!);
        await locator.hover({ timeout: options.stepTimeout });
        break;
      }

      case 'wait':
        await this.executeWait(page, action.condition, options.stepTimeout);
        break;

      case 'upload': {
        // File uploads during replay require parameterized file paths
        const locator = await this.resolveSelector(page, step.selectors!);
        await locator.setInputFiles(resolveUploadFiles(step, options.parameters));
        break;
      }

      case 'screenshot':
        // No-op during replay (or capture comparison screenshot)
        break;
    }
  }
}
```

### 4.3 Smart Selector Strategy

The most critical piece for reliable replay. Each recorded element gets multiple selector strategies, tried in order of reliability:

```typescript
// packages/agent-core/src/recording/selectors/selector-resolver.ts

export class SelectorResolver {
  /**
   * At RECORDING time: generate multiple selectors for a target element.
   */
  async generateSelectors(page: Page, elementHandle: ElementHandle): Promise<SelectorStrategy[]> {
    const selectors: SelectorStrategy[] = [];

    // 1. data-testid (most stable — explicit contract)
    const testId = await elementHandle.getAttribute('data-testid');
    if (testId) {
      selectors.push({
        type: 'test-id',
        value: `[data-testid="${testId}"]`,
        confidence: 0.95,
      });
    }

    // 2. ARIA role + name (semantic, resilient to DOM changes)
    const role = await elementHandle.getAttribute('role');
    const ariaLabel = await elementHandle.getAttribute('aria-label');
    if (role && ariaLabel) {
      selectors.push({
        type: 'aria-role',
        value: `role=${role}[name="${ariaLabel}"]`,
        confidence: 0.9,
      });
    }

    // 3. ARIA label alone
    if (ariaLabel) {
      selectors.push({
        type: 'aria-label',
        value: `[aria-label="${ariaLabel}"]`,
        confidence: 0.85,
      });
    }

    // 4. Visible text content (good for buttons, links)
    const text = await elementHandle.innerText().catch(() => null);
    if (text && text.length > 0 && text.length < 100) {
      selectors.push({
        type: 'text',
        value: `text="${text.trim()}"`,
        confidence: 0.8,
      });
    }

    // 5. Unique CSS selector (Playwright's auto-generated)
    const cssSelector = await this.computeMinimalCSSSelector(page, elementHandle);
    if (cssSelector) {
      selectors.push({
        type: 'css',
        value: cssSelector,
        confidence: 0.7,
      });
    }

    // 6. XPath (structural, last resort)
    const xpath = await this.computeXPath(page, elementHandle);
    if (xpath) {
      selectors.push({
        type: 'xpath',
        value: xpath,
        confidence: 0.5,
      });
    }

    // 7. nth-match (positional fallback)
    const nthMatch = await this.computeNthMatch(page, elementHandle);
    if (nthMatch) {
      selectors.push({
        type: 'nth-match',
        value: nthMatch,
        confidence: 0.3,
      });
    }

    return selectors.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * At REPLAY time: try selectors in order until one resolves.
   */
  async resolve(
    page: Page,
    selectors: SelectorStrategy[],
    timeout: number = 5000,
  ): Promise<Locator> {
    const errors: string[] = [];

    for (const selector of selectors) {
      try {
        let locator: Locator;

        switch (selector.type) {
          case 'test-id':
            locator = page.locator(selector.value);
            break;
          case 'aria-role':
            locator = page.getByRole(this.parseRole(selector.value), {
              name: this.parseRoleName(selector.value),
            });
            break;
          case 'aria-label':
            locator = page.locator(selector.value);
            break;
          case 'text':
            locator = page.getByText(this.parseTextSelector(selector.value));
            break;
          case 'css':
            locator = page.locator(selector.value);
            break;
          case 'xpath':
            locator = page.locator(`xpath=${selector.value}`);
            break;
          case 'nth-match':
            locator = page.locator(selector.value);
            break;
          default:
            continue;
        }

        // Verify the element exists and is visible
        await locator.waitFor({ state: 'visible', timeout: Math.min(timeout, 3000) });

        // Verify it's interactable
        const box = await locator.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          return locator;
        }
      } catch (error) {
        errors.push(`${selector.type}(${selector.value}): ${(error as Error).message}`);
        continue;
      }
    }

    throw new SelectorResolutionError(
      `All ${selectors.length} selector strategies failed`,
      selectors,
      errors,
    );
  }
}
```

### 4.4 Wait Strategies

```typescript
// packages/agent-core/src/recording/replay/wait-strategy.ts

export class WaitStrategyExecutor {
  async execute(page: Page, condition: WaitCondition, timeout: number): Promise<void> {
    switch (condition.type) {
      case 'networkIdle':
        await page.waitForLoadState('networkidle', { timeout });
        break;

      case 'selectorVisible':
        await page.locator(condition.value!).waitFor({ state: 'visible', timeout });
        break;

      case 'selectorHidden':
        await page.locator(condition.value!).waitFor({ state: 'hidden', timeout });
        break;

      case 'navigation':
        await page.waitForNavigation({ timeout });
        break;

      case 'timeout':
        await page.waitForTimeout(parseInt(condition.value!) || 1000);
        break;

      case 'custom':
        // Execute custom JavaScript condition
        await page.waitForFunction(condition.value!, { timeout });
        break;
    }
  }
}
```

### 4.5 Parameterization

Recordings can define parameters that replace hardcoded values during replay:

```typescript
export interface RecordingParameter {
  /** Parameter name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Default value (what was recorded) */
  defaultValue: string;

  /** Where this parameter is used (step indices + field paths) */
  usages: { stepIndex: number; fieldPath: string }[];

  /** Type hint for UI */
  type: 'text' | 'url' | 'email' | 'number' | 'password' | 'file-path';

  /** Validation pattern (optional) */
  validationPattern?: string;
}
```

**How parameterization works:**

1. During recording, the user (or an automatic heuristic) marks certain values as parameters
2. The marked values are replaced with `{{parameterName}}` tokens in the recording
3. Before replay, the user provides values for each parameter (or accepts defaults)
4. The `Parameterizer` substitutes tokens in each step before execution

**Auto-detection heuristic:** Values typed into form fields that appear in `<input>`, `<textarea>`, or `<select>` elements are suggested as parameters by default. The user confirms or dismisses each suggestion in the recording review UI.

### 4.6 Speed Control

| Mode                           | Behavior                                               |
| ------------------------------ | ------------------------------------------------------ |
| **Step-by-step** (speed=0)     | Pauses after each step; user clicks "Next" to continue |
| **0.5x**                       | 2× the original inter-step delay                       |
| **1x**                         | Original timing (capped at 5s per gap)                 |
| **2x**                         | Half the original inter-step delay                     |
| **5x**                         | 1/5th the original delay                               |
| **10x**                        | 1/10th the delay                                       |
| **Max speed** (speed=Infinity) | No inter-step delays, execute as fast as possible      |

Speed applies only to inter-step wait times. Action execution speed is determined by Playwright's own timeouts and the page's responsiveness.

---

## 5. Recording Format & Schema

### 5.1 File Format

Recordings are exported as `.accomplish-recording.zip` bundles. The archive contains the core `recording.json`, a `manifest.json`, and optional asset folders such as `screenshots/`.

```
recording.accomplish-recording.zip
  ├── manifest.json
  ├── recording.json
  └── screenshots/
      ├── step-000.jpg
      ├── step-003.jpg
      └── step-012.jpg
```

Legacy plain JSON import remains supported for backward compatibility.

### 5.2 Full JSON Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Accomplish Session Recording",
  "type": "object",
  "required": [
    "id",
    "schemaVersion",
    "name",
    "metadata",
    "steps",
    "privacyManifest",
    "createdAt",
    "updatedAt"
  ],
  "properties": {
    "id": {
      "type": "string",
      "format": "uuid",
      "description": "Unique recording identifier"
    },
    "schemaVersion": {
      "type": "integer",
      "minimum": 1,
      "description": "Schema version for forward compatibility"
    },
    "name": {
      "type": "string",
      "maxLength": 200,
      "description": "Human-readable recording name"
    },
    "description": {
      "type": "string",
      "maxLength": 2000,
      "description": "Optional longer description"
    },
    "metadata": {
      "type": "object",
      "required": [
        "source",
        "durationMs",
        "stepCount",
        "startUrl",
        "viewport",
        "appVersion",
        "platform"
      ],
      "properties": {
        "source": { "enum": ["agent", "user", "mixed"] },
        "sourceTaskId": { "type": "string" },
        "durationMs": { "type": "integer", "minimum": 0 },
        "stepCount": { "type": "integer", "minimum": 1 },
        "startUrl": { "type": "string", "format": "uri" },
        "viewport": {
          "type": "object",
          "required": ["width", "height"],
          "properties": {
            "width": { "type": "integer" },
            "height": { "type": "integer" }
          }
        },
        "userAgent": { "type": "string" },
        "appVersion": { "type": "string" },
        "platform": { "type": "string" }
      }
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["index", "id", "timestampMs", "action", "pageUrl", "origin"],
        "properties": {
          "index": { "type": "integer", "minimum": 0 },
          "id": { "type": "string" },
          "timestampMs": { "type": "integer", "minimum": 0 },
          "action": {
            "type": "object",
            "required": ["type"],
            "properties": {
              "type": {
                "enum": [
                  "navigate",
                  "click",
                  "fill",
                  "type",
                  "keypress",
                  "select",
                  "scroll",
                  "hover",
                  "upload",
                  "wait",
                  "screenshot",
                  "tool-call"
                ]
              }
            }
          },
          "selectors": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["type", "value", "confidence"],
              "properties": {
                "type": {
                  "enum": [
                    "css",
                    "xpath",
                    "text",
                    "aria-label",
                    "aria-role",
                    "test-id",
                    "nth-match"
                  ]
                },
                "value": { "type": "string" },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
              }
            }
          },
          "screenshot": { "type": "string", "contentEncoding": "base64" },
          "targetSnapshot": {
            "type": "object",
            "properties": {
              "role": { "type": "string" },
              "name": { "type": "string" },
              "tagName": { "type": "string" },
              "innerText": { "type": "string" },
              "attributes": { "type": "object" },
              "boundingBox": {
                "type": "object",
                "properties": {
                  "x": { "type": "number" },
                  "y": { "type": "number" },
                  "width": { "type": "number" },
                  "height": { "type": "number" }
                }
              }
            }
          },
          "pageUrl": { "type": "string" },
          "privacyAnnotations": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "field": { "type": "string" },
                "piiType": { "type": "string" },
                "reason": { "type": "string" }
              }
            }
          },
          "origin": { "enum": ["agent", "user"] },
          "agentContext": {
            "type": "object",
            "properties": {
              "toolName": { "type": "string" },
              "toolInput": { "type": "object" },
              "reasoning": { "type": "string" }
            }
          }
        }
      }
    },
    "privacyManifest": {
      "type": "object",
      "required": ["redactions", "totalPIIDetected", "pipelineVersion"],
      "properties": {
        "configSnapshot": { "type": "object" },
        "redactions": { "type": "array" },
        "totalPIIDetected": { "type": "integer" },
        "totalScreenshotsScrubbed": { "type": "integer" },
        "domainsVisited": { "type": "array", "items": { "type": "string" } },
        "pipelineVersion": { "type": "string" }
      }
    },
    "parameters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "description", "defaultValue", "usages", "type"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "defaultValue": { "type": "string" },
          "usages": { "type": "array" },
          "type": { "enum": ["text", "url", "email", "number", "password", "file-path"] },
          "validationPattern": { "type": "string" }
        }
      }
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" }
    },
    "createdAt": { "type": "string", "format": "date-time" },
    "updatedAt": { "type": "string", "format": "date-time" }
  }
}
```

### 5.3 Versioning Strategy

The `schemaVersion` field enables forward compatibility:

- **Version 1** (MVP): Core action types, basic privacy manifest, selector strategies
- **Version 2** (planned): Desktop-control actions, multi-tab support, conditional branching
- **Version 3** (planned): Visual assertions (screenshot comparison), loop constructs

The replay engine includes a schema migration layer that upgrades older recordings to the current format:

```typescript
export class RecordingMigrator {
  private migrations: Map<number, (recording: any) => any> = new Map([
    [1, (r) => r], // v1 is the base
    // [2, (r) => { /* add new fields with defaults */ return r; }],
  ]);

  migrate(recording: any): Recording {
    let current = recording;
    const targetVersion = CURRENT_SCHEMA_VERSION;

    for (let v = current.schemaVersion + 1; v <= targetVersion; v++) {
      const migrateFn = this.migrations.get(v);
      if (migrateFn) current = migrateFn(current);
      current.schemaVersion = v;
    }

    return current as Recording;
  }
}
```

---

## 6. Integration Points

### 6.1 Codebase Integration Map

```
packages/agent-core/
├── src/
│   ├── recording/                          ← NEW DIRECTORY
│   │   ├── types.ts                        ← Recording, RecordingStep, etc.
│   │   ├── recording-manager.ts            ← CRUD operations, SQLite persistence
│   │   ├── recording-interceptor.ts        ← Hooks into TaskCallbacks for agent recording
│   │   ├── user-session-recorder.ts        ← CDP-based user interaction capture
│   │   ├── privacy/
│   │   │   ├── privacy-pipeline.ts         ← Orchestrates all scrubbing
│   │   │   ├── pii-detector.ts             ← Regex-based PII detection
│   │   │   ├── form-classifier.ts          ← HTML form field classification
│   │   │   ├── screenshot-scrubber.ts      ← Image region blurring
│   │   │   └── url-sanitizer.ts            ← URL param redaction
│   │   ├── replay/
│   │   │   ├── replay-engine.ts            ← Step execution engine
│   │   │   ├── selector-resolver.ts        ← Multi-strategy selector resolution
│   │   │   ├── wait-strategy.ts            ← Adaptive wait conditions
│   │   │   ├── parameterizer.ts            ← Variable substitution
│   │   │   └── error-recovery.ts           ← Retry/skip/abort logic
│   │   ├── selectors/
│   │   │   ├── selector-generator.ts       ← Generate selectors at record time
│   │   │   └── selector-resolver.ts        ← Resolve selectors at replay time
│   │   └── export/
│   │       ├── exporter.ts                 ← .accomplish-recording file creation
│   │       ├── importer.ts                 ← File parsing & validation
│   │       └── migrator.ts                 ← Schema version migration
│   │
│   ├── internal/classes/
│   │   ├── TaskManager.ts                  ← MODIFY: Add recording lifecycle hooks
│   │   └── OpenCodeAdapter.ts              ← MODIFY: Forward tool events to RecordingInterceptor
│   │
│   ├── storage/
│   │   ├── migrations/
│   │   │   └── v017-recordings.ts          ← NEW: Recording tables migration
│   │   └── database.ts                     ← MODIFY: Register v017 migration
│   │
│   └── common/types/
│       └── task.ts                         ← MODIFY: Add recording-related task types
│
├── mcp-tools/
│   └── dev-browser/
│       └── src/
│           ├── screencast.ts               ← READ: Reuse ScreencastController for keyframes
│           └── index.ts                    ← MODIFY: Expose recording hooks
│
apps/desktop/
├── src/main/
│   ├── ipc/handlers/
│   │   └── recording-handlers.ts           ← NEW: IPC handlers for recording operations
│   └── permission-api.ts                   ← MODIFY: Add recording permission routes
│
apps/web/
├── src/client/
│   ├── stores/
│   │   └── recordingStore.ts               ← NEW: Zustand store for recording state
│   ├── components/
│   │   ├── recording/                      ← NEW DIRECTORY
│   │   │   ├── RecordButton.tsx            ← Record/stop toggle
│   │   │   ├── ReplayControls.tsx          ← Play/pause/step/speed controls
│   │   │   ├── RecordingLibrary.tsx        ← List of saved recordings
│   │   │   ├── RecordingDetail.tsx         ← View/edit a recording
│   │   │   ├── RecordingStepList.tsx       ← Step-by-step view with screenshots
│   │   │   ├── ParameterEditor.tsx         ← Edit replay parameters
│   │   │   ├── PrivacySettings.tsx         ← Configure scrubbing rules
│   │   │   └── ReplayProgress.tsx          ← Live replay progress indicator
│   │   └── execution/
│   │       └── BrowserPreview.tsx          ← MODIFY: Add record/replay indicators
```

### 6.2 Database Schema Additions

New migration: `v017-recordings.ts`

```sql
-- Core recordings table
CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('agent', 'user', 'mixed')),
  source_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  start_url TEXT NOT NULL,
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  step_count INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  tags TEXT, -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Recording steps (stored individually for efficient querying)
CREATE TABLE recording_steps (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  action_data TEXT NOT NULL, -- JSON
  selectors TEXT, -- JSON array
  screenshot BLOB, -- JPEG binary (more efficient than base64 in JSON)
  target_snapshot TEXT, -- JSON
  page_url TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'user')),
  agent_context TEXT, -- JSON
  privacy_annotations TEXT, -- JSON array
  UNIQUE(recording_id, step_index)
);

CREATE INDEX idx_recording_steps_recording ON recording_steps(recording_id);

-- Privacy manifest
CREATE TABLE recording_privacy_manifests (
  recording_id TEXT PRIMARY KEY REFERENCES recordings(id) ON DELETE CASCADE,
  config_snapshot TEXT NOT NULL, -- JSON
  redactions TEXT NOT NULL, -- JSON array
  total_pii_detected INTEGER NOT NULL DEFAULT 0,
  total_screenshots_scrubbed INTEGER NOT NULL DEFAULT 0,
  domains_visited TEXT, -- JSON array
  pipeline_version TEXT NOT NULL
);

-- Recording parameters (for replay customization)
CREATE TABLE recording_parameters (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_value TEXT NOT NULL,
  param_type TEXT NOT NULL CHECK (param_type IN ('text', 'url', 'email', 'number', 'password', 'file-path')),
  validation_pattern TEXT,
  usages TEXT NOT NULL, -- JSON: [{stepIndex, fieldPath}]
  UNIQUE(recording_id, name)
);

-- Replay history
CREATE TABLE replay_runs (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  steps_total INTEGER NOT NULL,
  steps_succeeded INTEGER NOT NULL DEFAULT 0,
  steps_failed INTEGER NOT NULL DEFAULT 0,
  steps_skipped INTEGER NOT NULL DEFAULT 0,
  parameter_values TEXT, -- JSON: {paramName: value}
  error_log TEXT, -- JSON array of step errors
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX idx_replay_runs_recording ON replay_runs(recording_id);

-- Privacy configuration (global settings)
CREATE TABLE recording_privacy_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  config TEXT NOT NULL -- JSON: PrivacyConfig
);
```

### 6.3 TaskManager Integration

The `TaskManager` needs new methods and callback wiring:

```typescript
// Additions to TaskManager.ts

export interface TaskManagerOptions {
  // ... existing options ...

  /** Recording manager instance */
  recordingManager?: RecordingManager;
}

// New methods on TaskManager:

/**
 * Start recording the current task execution.
 * Called when user clicks "Record" before or during a task.
 */
async startRecording(taskId: string, recordingName?: string): Promise<string> {
  const recording = await this.recordingManager.createRecording({
    name: recordingName ?? `Task ${taskId}`,
    source: 'agent',
    sourceTaskId: taskId
  });

  // Attach RecordingInterceptor to task callbacks
  const interceptor = new RecordingInterceptor(recording.id, this.recordingManager);
  this.activeRecordings.set(taskId, interceptor);

  return recording.id;
}

/**
 * Stop recording and finalize.
 */
async stopRecording(taskId: string): Promise<Recording> {
  const interceptor = this.activeRecordings.get(taskId);
  if (!interceptor) throw new Error(`No active recording for task ${taskId}`);

  const recording = await interceptor.finalize();
  this.activeRecordings.delete(taskId);
  return recording;
}
```

### 6.4 IPC Handlers

New handler file: `apps/desktop/src/main/ipc/handlers/recording-handlers.ts`

```typescript
export function registerRecordingHandlers(
  ipcMain: IpcMain,
  recordingManager: RecordingManager,
  taskManager: TaskManager,
) {
  // CRUD
  ipcMain.handle('recording:list', async () => recordingManager.listRecordings());
  ipcMain.handle('recording:get', async (_, id: string) => recordingManager.getRecording(id));
  ipcMain.handle('recording:delete', async (_, id: string) => recordingManager.deleteRecording(id));
  ipcMain.handle('recording:update', async (_, id: string, data: Partial<Recording>) =>
    recordingManager.updateRecording(id, data),
  );

  // Recording lifecycle
  ipcMain.handle('recording:start-agent', async (_, taskId: string, name?: string) =>
    taskManager.startRecording(taskId, name),
  );
  ipcMain.handle('recording:start-user', async (_, options: UserRecordingOptions) =>
    recordingManager.startUserRecording(options),
  );
  ipcMain.handle('recording:stop', async (_, recordingId: string) =>
    recordingManager.stopRecording(recordingId),
  );

  // Replay
  ipcMain.handle('recording:replay', async (_, recordingId: string, options: ReplayOptions) =>
    recordingManager.startReplay(recordingId, options),
  );
  ipcMain.handle('recording:replay-pause', async (_, replayId: string) =>
    recordingManager.pauseReplay(replayId),
  );
  ipcMain.handle('recording:replay-resume', async (_, replayId: string) =>
    recordingManager.resumeReplay(replayId),
  );
  ipcMain.handle('recording:replay-step', async (_, replayId: string) =>
    recordingManager.stepReplay(replayId),
  );
  ipcMain.handle('recording:replay-cancel', async (_, replayId: string) =>
    recordingManager.cancelReplay(replayId),
  );

  // Export/Import
  ipcMain.handle('recording:export', async (_, recordingId: string, filePath: string) =>
    recordingManager.exportRecording(recordingId, filePath),
  );
  ipcMain.handle('recording:import', async (_, filePath: string) =>
    recordingManager.importRecording(filePath),
  );

  // Privacy
  ipcMain.handle('recording:get-privacy-config', async () => recordingManager.getPrivacyConfig());
  ipcMain.handle('recording:set-privacy-config', async (_, config: PrivacyConfig) =>
    recordingManager.setPrivacyConfig(config),
  );

  // Forward replay events to renderer
  recordingManager.on('replay:step-start', (data) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('replay:step-start', data));
  });
  recordingManager.on('replay:step-complete', (data) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('replay:step-complete', data));
  });
  recordingManager.on('replay:error', (data) => {
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('replay:error', data));
  });
}
```

### 6.5 UI Components

**RecordButton** — Placed in the browser preview toolbar (alongside existing controls in `BrowserPreview.tsx`):

```tsx
// apps/web/src/client/components/recording/RecordButton.tsx

export function RecordButton({ taskId }: { taskId: string }) {
  const { isRecording, startRecording, stopRecording } = useRecordingStore();

  return (
    <button
      onClick={() => (isRecording ? stopRecording() : startRecording(taskId))}
      className={cn(
        'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium',
        isRecording
          ? 'bg-red-500 text-white animate-pulse'
          : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
      )}
    >
      <span className={cn('w-2 h-2 rounded-full', isRecording ? 'bg-white' : 'bg-red-500')} />
      {isRecording ? 'Stop Recording' : 'Record'}
    </button>
  );
}
```

**ReplayControls** — Transport bar shown during replay:

```tsx
export function ReplayControls({ replayId }: { replayId: string }) {
  const { state, currentStep, totalSteps, speed, setSpeed, pause, resume, step, cancel } =
    useReplay(replayId);

  return (
    <div className="flex items-center gap-3 p-2 bg-blue-50 border border-blue-200 rounded-lg">
      {/* Play/Pause */}
      <button onClick={state === 'paused' ? resume : pause}>
        {state === 'paused' ? <PlayIcon /> : <PauseIcon />}
      </button>

      {/* Step forward */}
      <button onClick={step} disabled={state !== 'paused'}>
        <StepForwardIcon />
      </button>

      {/* Cancel */}
      <button onClick={cancel}>
        <StopIcon />
      </button>

      {/* Progress */}
      <div className="flex-1">
        <div className="text-xs text-blue-700">
          Step {currentStep + 1} / {totalSteps}
        </div>
        <div className="h-1 bg-blue-100 rounded-full mt-1">
          <div
            className="h-full bg-blue-500 rounded-full transition-all"
            style={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
          />
        </div>
      </div>

      {/* Speed selector */}
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
        <option value={0}>Step-by-step</option>
        <option value={0.5}>0.5x</option>
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={5}>5x</option>
        <option value={10}>10x</option>
      </select>
    </div>
  );
}
```

**RecordingLibrary** — New tab/panel in the sidebar alongside task history:

```tsx
export function RecordingLibrary() {
  const { recordings, deleteRecording, exportRecording } = useRecordingStore();

  return (
    <div className="flex flex-col gap-2 p-4">
      <h2 className="text-lg font-semibold">Recordings</h2>
      {recordings.map((rec) => (
        <RecordingCard
          key={rec.id}
          recording={rec}
          onReplay={() => startReplay(rec.id)}
          onExport={() => exportRecording(rec.id)}
          onDelete={() => deleteRecording(rec.id)}
        />
      ))}
    </div>
  );
}
```

### 6.6 Preload Bridge Additions

```typescript
// Additions to apps/desktop/src/preload/index.ts

const accomplishAPI = {
  // ... existing API ...

  // Recording
  listRecordings: () => ipcRenderer.invoke('recording:list'),
  getRecording: (id: string) => ipcRenderer.invoke('recording:get', id),
  deleteRecording: (id: string) => ipcRenderer.invoke('recording:delete', id),
  startAgentRecording: (taskId: string, name?: string) =>
    ipcRenderer.invoke('recording:start-agent', taskId, name),
  startUserRecording: (options: UserRecordingOptions) =>
    ipcRenderer.invoke('recording:start-user', options),
  stopRecording: (recordingId: string) => ipcRenderer.invoke('recording:stop', recordingId),
  startReplay: (recordingId: string, options: ReplayOptions) =>
    ipcRenderer.invoke('recording:replay', recordingId, options),
  pauseReplay: (replayId: string) => ipcRenderer.invoke('recording:replay-pause', replayId),
  resumeReplay: (replayId: string) => ipcRenderer.invoke('recording:replay-resume', replayId),
  stepReplay: (replayId: string) => ipcRenderer.invoke('recording:replay-step', replayId),
  cancelReplay: (replayId: string) => ipcRenderer.invoke('recording:replay-cancel', replayId),
  exportRecording: (id: string, path: string) => ipcRenderer.invoke('recording:export', id, path),
  importRecording: (path: string) => ipcRenderer.invoke('recording:import', path),

  // Replay events
  onReplayStepStart: (cb: (data: any) => void) =>
    ipcRenderer.on('replay:step-start', (_, data) => cb(data)),
  onReplayStepComplete: (cb: (data: any) => void) =>
    ipcRenderer.on('replay:step-complete', (_, data) => cb(data)),
  onReplayError: (cb: (data: any) => void) => ipcRenderer.on('replay:error', (_, data) => cb(data)),
};
```

---

## 7. MVP Scope & Phasing

### 7.1 MVP vs Future

| Feature                                     | MVP | Future   |
| ------------------------------------------- | --- | -------- |
| Agent-driven session recording              | Yes | —        |
| User-driven (manual) session recording      | Yes | —        |
| Mixed session recording                     | —   | Phase 2  |
| Replay engine with multi-selector fallback  | Yes | —        |
| PII regex detection & redaction             | Yes | —        |
| Form field classification                   | Yes | —        |
| URL parameter sanitization                  | Yes | —        |
| Screenshot keyframes (scrubbed)             | Yes | —        |
| Replay speed control (1x, 2x, step-by-step) | Yes | —        |
| Parameterization (basic)                    | Yes | —        |
| Upload replay with file-path parameters     | Yes | —        |
| Export/import `.accomplish-recording` files | Yes | —        |
| Recording library UI                        | Yes | —        |
| Replay controls UI                          | Yes | —        |
| Privacy settings UI                         | Yes | —        |
| Screenshot region blurring                  | Yes | —        |
| Auto-parameter detection heuristic          | —   | Phase 2  |
| Conditional branching in recordings         | —   | Phase 3  |
| Loop constructs                             | —   | Phase 3  |
| Visual assertions (screenshot diff)         | —   | Phase 3  |
| Cross-machine sharing (encrypted)           | —   | Phase 3  |
| Multi-tab recording                         | —   | Phase 3  |
| Desktop-control (non-browser) recording     | —   | Phase 4  |
| Cloud sync                                  | —   | Phase 4+ |
| Collaborative recording editing             | —   | Phase 4+ |
| Recording marketplace / sharing             | —   | Phase 5+ |

### 7.2 Implementation Phases

#### Phase 1: Core Recording & Replay (MVP) — ~6-8 weeks

**Week 1-2: Foundation**

- Create `packages/agent-core/src/recording/` directory structure
- Define all TypeScript interfaces and types (`types.ts`)
- Implement `RecordingManager` with SQLite CRUD
- Write database migration `v017-recordings.ts`
- Add IPC handlers skeleton

**Week 3-4: Recording Engine**

- Implement `RecordingInterceptor` (hooks into TaskCallbacks for agent recording)
- Implement `UserSessionRecorder` (CDP event capture for manual sessions)
- Implement `SelectorGenerator` (multi-strategy selector creation)
- Implement privacy pipeline: `PIIDetector`, `FormFieldClassifier`, `URLSanitizer`
- Integration with `TaskManager` (startRecording/stopRecording methods)

**Week 5-6: Replay Engine**

- Implement `ReplayEngine` (step execution, timing, speed control)
- Implement `SelectorResolver` (multi-fallback resolution)
- Implement `WaitStrategyExecutor`
- Implement `Parameterizer` (basic variable substitution)
- Implement error recovery (retry, skip, abort)
- Export/import functionality

**Week 7-8: UI & Polish**

- `RecordButton` component
- `ReplayControls` component
- `RecordingLibrary` panel
- `RecordingDetail` / `RecordingStepList` views
- `ParameterEditor` for replay
- `PrivacySettings` panel
- Integration testing, edge case handling

#### Phase 2: Enhanced Privacy & Auto-Parameters — ~3-4 weeks

- Screenshot scrubbing with `sharp`
- Auto-parameter detection heuristic
- Mixed session recording (agent + user handoff)
- Privacy audit logging
- Bulk operations (delete multiple recordings, batch export)

#### Phase 3: Advanced Replay & Sharing — ~4-6 weeks

- Conditional branching (if element exists, take path A/B)
- Loop constructs (repeat steps N times or until condition)
- Visual assertions (screenshot comparison with tolerance)
- Multi-tab recording and replay
- Cross-machine sharing with encryption
- Schema migration for recording format v2

### 7.3 Key Technical Risks & Mitigations

| Risk                                           | Impact                        | Likelihood | Mitigation                                                                                                                   |
| ---------------------------------------------- | ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Selectors break across page versions**       | High — replay fails           | High       | Multi-strategy selectors with 7 fallback types; visual matching as last resort                                               |
| **PII slips through regex**                    | Critical — privacy breach     | Medium     | Defense in depth: regex + form classification + manual review option; paranoid mode redacts all form inputs                  |
| **CDP event capture misses user interactions** | Medium — incomplete recording | Medium     | Use injected JS + CDP listeners; test across SPA frameworks (React, Vue, Angular)                                            |
| **Large recordings consume too much storage**  | Low — performance             | Low        | Screenshots stored as compressed BLOB; configurable screenshot frequency; max recording duration                             |
| **Replay timing is non-deterministic**         | Medium — flaky replays        | High       | Adaptive waits (network idle + element visible) instead of fixed delays; retry logic                                         |
| **Electron IPC bottleneck during recording**   | Medium — dropped frames       | Low        | Batch step writes (100ms buffer); screenshots captured at key moments only, not continuously                                 |
| **Privacy scrubbing false positives**          | Low — data loss               | Medium     | Privacy manifest shows what was redacted; user can override per-field; confidence threshold configurable                     |
| **Dynamic SPAs break selector strategies**     | High — replay fails           | High       | Priority on semantic selectors (ARIA, text content) over structural (CSS, XPath); element snapshot comparison for validation |

---

## 8. Cross-Machine Sharing (Post-MVP)

### 8.1 Export Format

The `.accomplish-recording` file is already designed for portability. For cross-machine sharing, additional considerations:

**Environment Normalization:**

```typescript
export interface EnvironmentProfile {
  /** Screen dimensions at recording time */
  viewport: { width: number; height: number };

  /** Base URL (e.g., https://staging.example.com) */
  baseUrl: string;

  /** OS platform */
  platform: 'darwin' | 'win32' | 'linux';

  /** Browser version */
  browserVersion: string;
}

export interface ShareableRecording extends Recording {
  /** Environment profile for adaptation */
  environment: EnvironmentProfile;

  /** URL mapping rules for different environments */
  urlMappings: {
    pattern: string; // regex
    replacement: string;
    description: string;
  }[];
}
```

### 8.2 Handling Environment Differences

| Difference          | Strategy                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ |
| **Screen size**     | Scale coordinates proportionally; re-resolve selectors (coordinates are fallback only)     |
| **Base URL**        | URL mapping rules: `staging.example.com → production.example.com`                          |
| **Auth/login**      | Parameterize login credentials; recording skips auth steps if already logged in            |
| **Dynamic content** | Semantic selectors (text, ARIA) are content-aware; CSS selectors may need re-resolution    |
| **Locale/language** | Text-based selectors may fail; prefer ARIA role + test-id selectors for i18n apps          |
| **OS differences**  | Keyboard shortcuts (Cmd vs Ctrl) are normalized; file paths use platform-specific mappings |

### 8.3 Encryption for Shared Recordings

Shared recordings are encrypted using the same AES-256-GCM pattern as the existing `SecureStorage` (`packages/agent-core/src/storage/secure-storage.ts`), but with a user-provided passphrase instead of machine-derived keys:

```typescript
export class RecordingEncryptor {
  /**
   * Encrypt a recording for sharing.
   * Uses AES-256-GCM with a passphrase-derived key.
   */
  async encrypt(recording: Recording, passphrase: string): Promise<Buffer> {
    const salt = crypto.randomBytes(32);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(12);

    const plaintext = Buffer.from(JSON.stringify(recording), 'utf-8');
    const compressed = await gzip(plaintext);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Format: magic(4) + version(1) + salt(32) + iv(12) + authTag(16) + ciphertext
    const magic = Buffer.from('AREC'); // Accomplish RECording
    const version = Buffer.from([0x01]);

    return Buffer.concat([magic, version, salt, iv, authTag, encrypted]);
  }

  async decrypt(data: Buffer, passphrase: string): Promise<Recording> {
    const magic = data.subarray(0, 4).toString();
    if (magic !== 'AREC') throw new Error('Invalid recording file');

    const version = data[4];
    if (version !== 1) throw new Error(`Unsupported version: ${version}`);

    const salt = data.subarray(5, 37);
    const iv = data.subarray(37, 49);
    const authTag = data.subarray(49, 65);
    const ciphertext = data.subarray(65);

    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const plaintext = await gunzip(compressed);

    return JSON.parse(plaintext.toString('utf-8'));
  }
}
```

Encrypted files use the `.accomplish-recording.enc` extension.

---

## 9. Appendix: Edge Cases & Open Questions

### 9.1 Edge Cases

**Multi-tab interactions:** MVP records only the active tab. If the recording involves opening a new tab (e.g., OAuth popup), the recorder captures the navigation but may lose context on the secondary tab. Phase 3 addresses this with multi-tab support.

**iframes:** Playwright can interact with iframes via `frame.locator()`. The selector generator must include the frame selector path. CDP events from iframes are routed through the parent page's CDP session but carry frame identifiers.

**Shadow DOM:** Some web components use Shadow DOM, which makes CSS selectors unreliable. The selector generator should detect shadow roots and use `pierce/` selectors or `page.locator('custom-element').locator('internal-element')` chains.

**File downloads:** When the browser triggers a file download, the recorder captures the navigation/click that triggered it. Replay needs to handle the download dialog (auto-accept or ask user).

**CAPTCHA and 2FA:** Recordings that include CAPTCHA or 2FA challenges cannot be fully automated on replay. The replay engine should detect these (common patterns: reCAPTCHA iframe, TOTP input fields) and pause for user intervention.

**Infinite scroll / lazy loading:** Pages with infinite scroll may have different content at replay time. The recorder should capture scroll position and expected content checksums. The replay engine scrolls until expected content appears (or times out).

**SPA client-side routing:** Single-page applications use `pushState` / `replaceState` for navigation, which doesn't trigger full page loads. The recorder must listen for `popstate` events and URL changes via a `MutationObserver` on the address bar.

**Race conditions during recording:** If the user interacts with the page while the agent is also controlling it (mixed mode), events may interleave unpredictably. The recorder uses timestamps to order events, but simultaneous actions on the same element will be flagged for manual review.

### 9.2 Open Questions

1. **Should we record network requests/responses for API-driven pages?** This would enable offline replay but massively increases recording size and privacy exposure. Recommendation: No for MVP; consider a "network mock" mode in Phase 4.

2. **Should recordings be editable?** Users may want to insert, delete, or reorder steps post-recording. This requires a recording editor UI with preview capability. Recommendation: Basic step deletion in MVP; full editor in Phase 3.

3. **How to handle authentication during replay?** Options include parameterized credentials, cookie injection, or a pre-replay "setup" phase. Recommendation: Parameterized login steps for MVP; saved auth profiles in Phase 3.

4. **Should we support recording to/from non-Chromium browsers?** The current dev-browser MCP uses Playwright with Chromium. Firefox and WebKit support is theoretically possible via Playwright but would require testing all CDP-specific code paths. Recommendation: Chromium only for MVP; multi-browser in Phase 4.

5. **Recording size limits?** Very long sessions could produce enormous recordings. Recommendation: Configurable max step count (default 500) and max duration (default 30 minutes) with user override.

6. **Integration with CI/CD?** Recordings could serve as E2E tests. A CLI replay command (`accomplish replay <file>`) would enable this. Recommendation: Phase 3 alongside conditional branching and assertions.

---

_This document is a living plan. Section details will be refined during implementation as architectural decisions are validated against the actual codebase._
