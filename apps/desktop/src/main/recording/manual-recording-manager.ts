import {
  DEV_BROWSER_CDP_PORT,
  DEV_BROWSER_PORT,
  type ElementSnapshot,
  type PrivacyAnnotation,
  type PrivacyConfig,
  type Recording,
  type RecordingAction,
  type SelectorStrategy,
} from '@accomplish_ai/agent-core/common';
import type { RecordingManager } from '@accomplish_ai/agent-core/recording/index.js';
import { createConsoleLogger } from '@accomplish_ai/agent-core/utils/index.js';
import { recoverDevBrowserServer } from '../opencode/electron-options';

const DEV_BROWSER_HOST = '127.0.0.1';
const COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MANUAL_RECORDER_POLL_MS = 250;
const SCREENSHOT_QUALITY = 55;
const log = createConsoleLogger({ prefix: 'ManualRecordingManager' });

function normalizeStartUrl(startUrl?: string): string | undefined {
  const trimmed = startUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed);
  const candidate = hasProtocol
    ? trimmed
    : `${isLikelyLocalAddress(trimmed) ? 'http' : 'https'}://${trimmed}`;

  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`Invalid start URL: ${trimmed}`);
  }
}

function isLikelyLocalAddress(value: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
}

interface CdpCommandResponse {
  id: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ManualRawEvent {
  kind: 'click' | 'fill' | 'select' | 'keypress' | 'scroll';
  timestamp: number;
  pageUrl: string;
  selectors?: SelectorStrategy[];
  button?: number;
  clickCount?: number;
  x?: number;
  y?: number;
  value?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
}

interface ManualDrainPayload {
  events: ManualRawEvent[];
  url: string;
}

interface ManualRecordingSession {
  recordingId: string;
  pageName: string;
  targetId: string;
  cdp: CdpClient;
  cdpSessionId: string;
  pollTimer: ReturnType<typeof setInterval>;
  lastPageUrl: string;
}

interface ManualScreenshotMaskResult {
  maskedRegionCount: number;
  targetSnapshot: ElementSnapshot | null;
  viewport: { width: number; height: number };
}

interface ManualStepArtifacts {
  screenshot?: string;
  targetSnapshot?: ElementSnapshot;
  privacyAnnotations?: PrivacyAnnotation[];
}

function isMissingSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('session with given id not found') ||
    message.includes('session closed') ||
    message.includes('target closed')
  );
}

function serializeForEvaluation(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();

  async connect(endpoint: string): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    const ws = new WebSocket(endpoint);

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Failed to connect to CDP endpoint: ${endpoint}`));
      };
      const cleanup = () => {
        ws.removeEventListener('open', handleOpen);
        ws.removeEventListener('error', handleError);
      };

      ws.addEventListener('open', handleOpen);
      ws.addEventListener('error', handleError);
    });

    ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data);
    });
    ws.addEventListener('close', () => {
      this.rejectAllPending(new Error('CDP websocket closed'));
    });
    ws.addEventListener('error', () => {
      this.rejectAllPending(new Error('CDP websocket error'));
    });

    this.ws = ws;
  }

  async sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP websocket is not connected');
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params) {
      payload.params = params;
    }
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error('CDP disconnected'));
    if (this.ws && this.ws.readyState < WebSocket.CLOSING) {
      this.ws.close();
    }
    this.ws = null;
  }

  private async handleMessage(rawData: unknown): Promise<void> {
    const raw = await this.toText(rawData);
    if (!raw) {
      return;
    }

    let message: CdpCommandResponse;
    try {
      message = JSON.parse(raw) as CdpCommandResponse;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error?.message) {
      pending.reject(new Error(message.error.message));
      return;
    }

    pending.resolve(message.result ?? {});
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async toText(rawData: unknown): Promise<string | null> {
    if (typeof rawData === 'string') {
      return rawData;
    }
    if (rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf8');
    }
    if (ArrayBuffer.isView(rawData)) {
      return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString('utf8');
    }
    if (typeof Blob !== 'undefined' && rawData instanceof Blob) {
      return rawData.text();
    }
    return null;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveBrowserWsEndpoint(): Promise<string> {
  const info = await fetchJson<{ webSocketDebuggerUrl: string }>(
    `http://${DEV_BROWSER_HOST}:${DEV_BROWSER_CDP_PORT}/json/version`,
  );
  if (!info.webSocketDebuggerUrl) {
    throw new Error('CDP endpoint missing webSocketDebuggerUrl');
  }
  return info.webSocketDebuggerUrl;
}

async function createManualPage(
  recordingId: string,
  viewport: { width: number; height: number },
): Promise<{ pageName: string; targetId: string }> {
  const pageName = `manual-recording-${recordingId}`;
  const result = await fetchJson<{ targetId: string }>(
    `http://${DEV_BROWSER_HOST}:${DEV_BROWSER_PORT}/pages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: pageName, viewport }),
    },
  );

  if (!result.targetId) {
    throw new Error('Failed to create manual recording page');
  }

  return { pageName, targetId: result.targetId };
}

async function evaluateExpression<T>(
  cdp: CdpClient,
  sessionId: string,
  expression: string,
): Promise<T> {
  const result = (await cdp.sendCommand(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  )) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  };

  if (result.exceptionDetails?.text) {
    throw new Error(result.exceptionDetails.text);
  }

  return (result.result?.value ?? null) as T;
}

async function waitForDocumentReady(
  cdp: CdpClient,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = await evaluateExpression<string>(cdp, sessionId, `(() => document.readyState)()`);
    if (state === 'complete' || state === 'interactive') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for page load');
}

function buildManualRecorderBootstrap(): string {
  return `
    (() => {
      if (window.__accomplishManualRecorder?.drain) {
        return true;
      }

      const queue = [];
      let lastViewportX = window.scrollX;
      let lastViewportY = window.scrollY;
      let scrollTimer = null;

      const trimText = (value) => {
        if (!value) {
          return '';
        }
        return String(value).replace(/\\s+/g, ' ').trim().slice(0, 120);
      };

      const inferRole = (element) => {
        const explicitRole = element.getAttribute('role');
        if (explicitRole) {
          return explicitRole;
        }
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'button') {
          return 'button';
        }
        if (tagName === 'a' && element.hasAttribute('href')) {
          return 'link';
        }
        if (tagName === 'select') {
          return 'combobox';
        }
        if (tagName === 'textarea') {
          return 'textbox';
        }
        if (tagName === 'input') {
          const inputType = (element.getAttribute('type') || 'text').toLowerCase();
          if (inputType === 'checkbox') {
            return 'checkbox';
          }
          if (inputType === 'radio') {
            return 'radio';
          }
          return 'textbox';
        }
        return null;
      };

      const getAccessibleName = (element) => {
        const ariaLabel = trimText(element.getAttribute('aria-label'));
        if (ariaLabel) {
          return ariaLabel;
        }
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelText = labelledBy
            .split(/\\s+/)
            .map((id) => trimText(document.getElementById(id)?.textContent))
            .filter(Boolean)
            .join(' ');
          if (labelText) {
            return labelText;
          }
        }
        if ('labels' in element && element.labels) {
          const labelText = Array.from(element.labels)
            .map((label) => trimText(label.textContent))
            .filter(Boolean)
            .join(' ');
          if (labelText) {
            return labelText;
          }
        }
        return trimText(element.getAttribute('placeholder')) || trimText(element.textContent);
      };

      const buildCssSelector = (element) => {
        if (element.id) {
          return '#' + CSS.escape(element.id);
        }
        const testId = element.getAttribute('data-testid');
        if (testId) {
          return '[data-testid="' + CSS.escape(testId) + '"]';
        }
        const name = element.getAttribute('name');
        const tagName = element.tagName.toLowerCase();
        if (name) {
          return tagName + '[name="' + CSS.escape(name) + '"]';
        }
        const classes = Array.from(element.classList).slice(0, 2);
        if (classes.length > 0) {
          return tagName + '.' + classes.map((cls) => CSS.escape(cls)).join('.');
        }
        return tagName;
      };

      const buildXPath = (element) => {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) {
          return null;
        }
        const segments = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          const tagName = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
            : [current];
          const index = siblings.indexOf(current) + 1;
          segments.unshift(tagName + '[' + index + ']');
          current = current.parentElement;
        }
        return '/' + segments.join('/');
      };

      const buildSelectors = (element) => {
        const selectors = [];
        const css = buildCssSelector(element);
        if (css) {
          selectors.push({ type: 'css', value: css, confidence: 0.95 });
        }

        const xpath = buildXPath(element);
        if (xpath) {
          selectors.push({ type: 'xpath', value: xpath, confidence: 0.82 });
        }

        const testId = trimText(element.getAttribute('data-testid'));
        if (testId) {
          selectors.push({ type: 'test-id', value: testId, confidence: 0.93 });
        }

        const ariaLabel = trimText(element.getAttribute('aria-label'));
        if (ariaLabel) {
          selectors.push({ type: 'aria-label', value: ariaLabel, confidence: 0.9 });
        }

        const role = inferRole(element);
        const name = getAccessibleName(element);
        if (role) {
          selectors.push({
            type: 'aria-role',
            value: JSON.stringify({ role, name: name || null }),
            confidence: name ? 0.88 : 0.74,
          });
        }

        const text = trimText(element.textContent);
        if (text) {
          selectors.push({ type: 'text', value: text, confidence: 0.7 });
        }

        return selectors;
      };

      const push = (event) => {
        queue.push({
          ...event,
          timestamp: Date.now(),
          pageUrl: window.location.href,
        });
      };

      document.addEventListener(
        'click',
        (event) => {
          const target = event.target instanceof Element ? event.target.closest('*') : null;
          if (!target) {
            return;
          }
          push({
            kind: 'click',
            selectors: buildSelectors(target),
            button: event.button,
            clickCount: event.detail || 1,
            x: event.clientX,
            y: event.clientY,
          });
        },
        true,
      );

      document.addEventListener(
        'change',
        (event) => {
          const target = event.target instanceof Element ? event.target : null;
          if (!target) {
            return;
          }
          const selectors = buildSelectors(target);
          if (target instanceof HTMLSelectElement) {
            push({
              kind: 'select',
              selectors,
              value: target.value,
            });
            return;
          }
          if (target instanceof HTMLInputElement) {
            const inputType = target.type.toLowerCase();
            if (inputType === 'file') {
              const files = Array.from(target.files ?? []);
              push({
                kind: 'upload',
                selectors,
                fileNames: files.map((file) => file.name),
                mimeTypes: files.map((file) => file.type || 'application/octet-stream'),
              });
              return;
            }
            if (inputType === 'checkbox' || inputType === 'radio') {
              return;
            }
          }
          if ('value' in target || target.isContentEditable) {
            push({
              kind: 'fill',
              selectors,
              value: target.isContentEditable ? trimText(target.textContent) : String(target.value || ''),
            });
          }
        },
        true,
      );

      document.addEventListener(
        'keydown',
        (event) => {
          const shouldCapture =
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
          if (!shouldCapture) {
            return;
          }
          push({
            kind: 'keypress',
            key: event.key,
            modifiers: [
              event.metaKey ? 'Meta' : null,
              event.ctrlKey ? 'Control' : null,
              event.altKey ? 'Alt' : null,
              event.shiftKey ? 'Shift' : null,
            ].filter(Boolean),
          });
        },
        true,
      );

      window.addEventListener(
        'scroll',
        () => {
          if (scrollTimer) {
            clearTimeout(scrollTimer);
          }
          scrollTimer = setTimeout(() => {
            const deltaX = window.scrollX - lastViewportX;
            const deltaY = window.scrollY - lastViewportY;
            if (deltaX || deltaY) {
              push({
                kind: 'scroll',
                deltaX,
                deltaY,
              });
              lastViewportX = window.scrollX;
              lastViewportY = window.scrollY;
            }
          }, 120);
        },
        { passive: true },
      );

      window.__accomplishManualRecorder = {
        drain() {
          const events = queue.slice();
          queue.length = 0;
          return events;
        },
      };

      return true;
    })()
  `;
}

function mapMouseButton(button?: number): 'left' | 'right' | 'middle' {
  if (button === 2) {
    return 'right';
  }
  if (button === 1) {
    return 'middle';
  }
  return 'left';
}

function mapManualEventToStepInput(
  event: ManualRawEvent,
): { action: RecordingAction; selectors?: SelectorStrategy[]; pageUrl: string } | null {
  switch (event.kind) {
    case 'click':
      return {
        action: {
          type: 'click',
          button: mapMouseButton(event.button),
          clickCount: event.clickCount ?? 1,
          x: event.x,
          y: event.y,
        },
        selectors: event.selectors,
        pageUrl: event.pageUrl,
      };
    case 'fill':
      return {
        action: {
          type: 'fill',
          value: event.value ?? '',
          clearFirst: true,
        },
        selectors: event.selectors,
        pageUrl: event.pageUrl,
      };
    case 'select':
      return {
        action: {
          type: 'select',
          values: event.value ? [event.value] : [],
        },
        selectors: event.selectors,
        pageUrl: event.pageUrl,
      };
    case 'keypress':
      if (!event.key) {
        return null;
      }
      return {
        action: {
          type: 'keypress',
          key: event.key,
          modifiers: event.modifiers ?? [],
        },
        pageUrl: event.pageUrl,
      };
    case 'scroll':
      return {
        action: {
          type: 'scroll',
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          target: 'viewport',
        },
        pageUrl: event.pageUrl,
      };
    default:
      return null;
  }
}

function shouldCaptureScreenshot(action: RecordingAction): boolean {
  return (
    action.type === 'navigate' ||
    action.type === 'click' ||
    action.type === 'fill' ||
    action.type === 'select'
  );
}

function buildScreenshotMaskExpression(
  selectors: SelectorStrategy[] | undefined,
  config: PrivacyConfig,
) {
  const payload = serializeForEvaluation({
    selectors: selectors ?? [],
    captureScreenshots: config.captureScreenshots,
    blurAllScreenshots: config.blurAllScreenshots,
    redactAllFormInputs: config.redactAllFormInputs,
    customSensitiveKeys: config.customSensitiveKeys,
  });

  return `
    (() => {
      const payload = ${payload};
      const cleanup = window.__accomplishScreenshotMaskCleanup;
      if (typeof cleanup === 'function') {
        cleanup();
      }

      const overlays = [];
      const selectorEntries = Array.isArray(payload.selectors) ? payload.selectors : [];
      const customSensitiveKeys = Array.isArray(payload.customSensitiveKeys)
        ? payload.customSensitiveKeys
            .filter((value) => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.toLowerCase())
        : [];
      const defaultSensitiveKeys = [
        'email',
        'e-mail',
        'pass',
        'password',
        'otp',
        'pin',
        'token',
        'secret',
        'session',
        'auth',
        'api-key',
        'apikey',
        'verification',
        'code',
      ];
      const sensitiveKeys = Array.from(new Set([...defaultSensitiveKeys, ...customSensitiveKeys]));

      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const normalizeText = (value) => {
        if (!value) {
          return '';
        }
        return String(value).replace(/\\s+/g, ' ').trim();
      };

      const resolveSelector = (selector) => {
        if (!selector || typeof selector.value !== 'string') {
          return null;
        }

        try {
          if (selector.type === 'css') {
            return document.querySelector(selector.value);
          }

          if (selector.type === 'xpath') {
            return document.evaluate(
              selector.value,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null,
            ).singleNodeValue;
          }

          if (selector.type === 'test-id') {
            return document.querySelector('[data-testid="' + CSS.escape(selector.value) + '"]');
          }

          if (selector.type === 'aria-label') {
            return document.querySelector('[aria-label="' + CSS.escape(selector.value) + '"]');
          }

          if (selector.type === 'text') {
            const targetText = normalizeText(selector.value);
            const candidates = Array.from(document.querySelectorAll('body *'));
            return (
              candidates.find(
                (candidate) =>
                  normalizeText(candidate.textContent) === targetText && isVisible(candidate),
              ) || null
            );
          }

          if (selector.type === 'aria-role') {
            const parsed = JSON.parse(selector.value);
            const role = normalizeText(parsed?.role).toLowerCase();
            const name = normalizeText(parsed?.name);
            const candidates = Array.from(document.querySelectorAll(role ? '[role="' + CSS.escape(role) + '"]' : 'body *'));
            return (
              candidates.find((candidate) => {
                const candidateRole = normalizeText(candidate.getAttribute('role')).toLowerCase();
                if (role && candidateRole !== role) {
                  return false;
                }
                if (!name) {
                  return isVisible(candidate);
                }
                const accessibleName = normalizeText(
                  candidate.getAttribute('aria-label') ||
                    candidate.getAttribute('placeholder') ||
                    candidate.textContent,
                );
                return accessibleName === name && isVisible(candidate);
              }) || null
            );
          }
        } catch {
          return null;
        }

        return null;
      };

      const targetElement =
        selectorEntries
          .map((selector) => resolveSelector(selector))
          .find((candidate) => candidate instanceof Element) || null;

      const createSnapshot = (element) => {
        if (!(element instanceof Element)) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        const attributes = {};
        for (const attribute of Array.from(element.attributes)) {
          attributes[attribute.name] = attribute.value;
        }
        return {
          role: normalizeText(element.getAttribute('role')) || element.tagName.toLowerCase(),
          name:
            normalizeText(element.getAttribute('aria-label')) ||
            normalizeText(element.getAttribute('placeholder')) ||
            normalizeText(element.textContent),
          tagName: element.tagName.toLowerCase(),
          innerText: normalizeText(element.textContent) || undefined,
          attributes,
          boundingBox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      };

      const shouldMaskElement = (element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) {
          return false;
        }

        if (payload.redactAllFormInputs) {
          return true;
        }

        if (element instanceof HTMLInputElement) {
          const inputType = normalizeText(element.type).toLowerCase();
          if (inputType === 'password') {
            return true;
          }
        }

        const candidates = [
          element.getAttribute('name'),
          element.getAttribute('id'),
          element.getAttribute('placeholder'),
          element.getAttribute('aria-label'),
          element.getAttribute('autocomplete'),
          element.getAttribute('data-testid'),
        ]
          .map((value) => normalizeText(value).toLowerCase())
          .filter(Boolean);

        return sensitiveKeys.some((key) => candidates.some((candidate) => candidate.includes(key)));
      };

      const createOverlay = (rect) => {
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          return;
        }

        const overlay = document.createElement('div');
        overlay.setAttribute('data-accomplish-screenshot-mask', 'true');
        overlay.style.position = 'fixed';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.borderRadius = '8px';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '2147483647';
        overlay.style.background = 'rgba(255, 255, 255, 0.18)';
        overlay.style.backdropFilter = 'blur(18px)';
        overlay.style.webkitBackdropFilter = 'blur(18px)';
        document.documentElement.appendChild(overlay);
        overlays.push(overlay);
      };

      if (!payload.captureScreenshots) {
        // Snapshot-only mode; skip mask overlays entirely.
      } else if (payload.blurAllScreenshots) {
        createOverlay({
          left: 0,
          top: 0,
          width: window.innerWidth,
          height: window.innerHeight,
        });
      } else {
        const candidates = Array.from(
          document.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
        );
        for (const element of candidates) {
          if (shouldMaskElement(element)) {
            createOverlay(element.getBoundingClientRect());
          }
        }
      }

      window.__accomplishScreenshotMaskCleanup = () => {
        for (const overlay of overlays) {
          overlay.remove();
        }
      };

      return {
        maskedRegionCount: overlays.length,
        targetSnapshot: createSnapshot(targetElement),
        viewport: {
          width: Math.max(window.innerWidth || 0, 1),
          height: Math.max(window.innerHeight || 0, 1),
        },
      };
    })()
  `;
}

async function cleanupScreenshotMask(cdp: CdpClient, sessionId: string): Promise<void> {
  await evaluateExpression(
    cdp,
    sessionId,
    `
      (() => {
        const cleanup = window.__accomplishScreenshotMaskCleanup;
        if (typeof cleanup === 'function') {
          cleanup();
        }
        window.__accomplishScreenshotMaskCleanup = undefined;
        return true;
      })()
    `,
  ).catch(() => {});
}

export class ManualRecordingManager {
  private session: ManualRecordingSession | null = null;

  constructor(private readonly recordingManager: RecordingManager) {}

  async startRecording(name?: string, startUrl?: string): Promise<Recording> {
    if (this.session) {
      const existing = this.recordingManager.getRecording(this.session.recordingId);
      if (existing) {
        return existing;
      }
    }

    const normalizedStartUrl = normalizeStartUrl(startUrl);
    await recoverDevBrowserServer(undefined, {
      force: true,
      reason: 'Preparing browser for manual recording...',
    });

    const recording = await this.recordingManager.startManualRecording(name, normalizedStartUrl);
    const cdp = new CdpClient();
    let targetId: string | null = null;

    try {
      const [{ pageName, targetId: resolvedTargetId }, wsEndpoint] = await Promise.all([
        createManualPage(recording.id, recording.metadata.viewport ?? DEFAULT_VIEWPORT),
        resolveBrowserWsEndpoint(),
      ]);
      targetId = resolvedTargetId;

      await cdp.connect(wsEndpoint);
      const cdpSessionId = await this.attachToManualPage(cdp, resolvedTargetId);

      const initialUrl = normalizedStartUrl;
      if (initialUrl) {
        await cdp.sendCommand('Page.navigate', { url: initialUrl }, cdpSessionId);
        await waitForDocumentReady(cdp, cdpSessionId, COMMAND_TIMEOUT_MS);
        const artifacts = await this.captureStepArtifacts(cdp, cdpSessionId, {
          type: 'navigate',
          url: initialUrl,
          navigationType: 'goto',
        });
        this.recordingManager.recordManualStep(recording.id, {
          action: { type: 'navigate', url: initialUrl, navigationType: 'goto' },
          pageUrl: initialUrl,
          screenshot: artifacts.screenshot,
          targetSnapshot: artifacts.targetSnapshot,
          privacyAnnotations: artifacts.privacyAnnotations,
        });
      }

      const session: ManualRecordingSession = {
        recordingId: recording.id,
        pageName,
        targetId: resolvedTargetId,
        cdp,
        cdpSessionId,
        lastPageUrl: initialUrl || recording.metadata.startUrl,
        pollTimer: setInterval(() => {
          void this.flushSessionEvents(session).catch((error) => {
            void this.handleSessionPollingError(session, error);
          });
        }, MANUAL_RECORDER_POLL_MS),
      };

      this.session = session;
      return recording;
    } catch (error) {
      if (targetId) {
        await cdp.sendCommand('Target.closeTarget', { targetId }).catch(() => {});
      }
      await cdp.disconnect().catch(() => {});
      this.recordingManager.finalizeManualRecording(recording.id, 'failed');
      throw error;
    }
  }

  async stopRecording(recordingId: string): Promise<Recording> {
    if (!this.session || this.session.recordingId !== recordingId) {
      return this.recordingManager.finalizeManualRecording(recordingId);
    }

    const session = this.session;
    this.session = null;
    clearInterval(session.pollTimer);

    try {
      await this.flushSessionEvents(session);
    } finally {
      await session.cdp
        .sendCommand('Target.closeTarget', { targetId: session.targetId })
        .catch(() => {});
      await session.cdp.disconnect().catch(() => {});
    }

    return this.recordingManager.finalizeManualRecording(recordingId);
  }

  getActiveRecording(): Recording | null {
    if (!this.session) {
      return null;
    }
    return this.recordingManager.getRecording(this.session.recordingId);
  }

  private async captureStepArtifacts(
    cdp: CdpClient,
    cdpSessionId: string,
    action: RecordingAction,
    selectors?: SelectorStrategy[],
  ): Promise<ManualStepArtifacts> {
    const config = this.recordingManager.getPrivacyConfig();
    if (!config.captureScreenshots && !selectors?.length) {
      return {};
    }

    const maskResult = await evaluateExpression<ManualScreenshotMaskResult>(
      cdp,
      cdpSessionId,
      buildScreenshotMaskExpression(selectors, config),
    );

    const targetSnapshot = maskResult.targetSnapshot ?? undefined;
    const privacyAnnotations: PrivacyAnnotation[] =
      config.captureScreenshots && maskResult.maskedRegionCount > 0
        ? [
            {
              type: 'custom',
              path: 'screenshot',
              replacement: `[SCREENSHOT_MASKED_${maskResult.maskedRegionCount}]`,
            },
          ]
        : [];

    try {
      if (!config.captureScreenshots || !shouldCaptureScreenshot(action)) {
        return {
          privacyAnnotations: privacyAnnotations.length > 0 ? privacyAnnotations : undefined,
          targetSnapshot,
        };
      }

      const viewportWidth = Math.max(maskResult.viewport.width, 1);
      const viewportHeight = Math.max(maskResult.viewport.height, 1);
      const widthScale =
        config.maxScreenshotWidth > 0 ? config.maxScreenshotWidth / viewportWidth : 1;
      const heightScale =
        config.maxScreenshotHeight > 0 ? config.maxScreenshotHeight / viewportHeight : 1;
      const scale = Math.max(Math.min(widthScale, heightScale, 1), 0.1);

      const result = (await cdp.sendCommand(
        'Page.captureScreenshot',
        {
          format: 'jpeg',
          quality: SCREENSHOT_QUALITY,
          captureBeyondViewport: false,
          clip: {
            x: 0,
            y: 0,
            width: viewportWidth,
            height: viewportHeight,
            scale,
          },
        },
        cdpSessionId,
      )) as { data?: string };

      return {
        screenshot: result.data,
        targetSnapshot,
        privacyAnnotations: privacyAnnotations.length > 0 ? privacyAnnotations : undefined,
      };
    } finally {
      await cleanupScreenshotMask(cdp, cdpSessionId);
    }
  }

  private async handleSessionPollingError(
    session: ManualRecordingSession,
    error: unknown,
  ): Promise<void> {
    if (this.session?.recordingId !== session.recordingId) {
      return;
    }

    if (isMissingSessionError(error)) {
      try {
        session.cdpSessionId = await this.attachToManualPage(session.cdp, session.targetId);
        await this.flushSessionEvents(session);
        return;
      } catch (reattachError) {
        log.error('Manual recording session recovery failed', {
          recordingId: session.recordingId,
          error: reattachError instanceof Error ? reattachError.message : String(reattachError),
        });
      }
    }

    this.session = null;
    clearInterval(session.pollTimer);
    log.error('Manual recording polling failed', {
      recordingId: session.recordingId,
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      await session.cdp
        .sendCommand('Target.closeTarget', { targetId: session.targetId })
        .catch(() => {});
      await session.cdp.disconnect().catch(() => {});
    } finally {
      this.recordingManager.finalizeManualRecording(session.recordingId, 'failed');
    }
  }

  private async flushSessionEvents(session: ManualRecordingSession): Promise<void> {
    const payload = await evaluateExpression<ManualDrainPayload>(
      session.cdp,
      session.cdpSessionId,
      `
        (() => {
          const recorder = window.__accomplishManualRecorder;
          const events =
            recorder && typeof recorder.drain === 'function' ? recorder.drain() : [];
          return {
            events,
            url: window.location.href,
          };
        })()
      `,
    );

    let currentPageUrl = session.lastPageUrl;
    const recordNavigationStep = async (pageUrl: string) => {
      const artifacts = await this.captureStepArtifacts(session.cdp, session.cdpSessionId, {
        type: 'navigate',
        url: pageUrl,
        navigationType: 'goto',
      });
      this.recordingManager.recordManualStep(session.recordingId, {
        action: {
          type: 'navigate',
          url: pageUrl,
          navigationType: 'goto',
        },
        pageUrl,
        screenshot: artifacts.screenshot,
        targetSnapshot: artifacts.targetSnapshot,
        privacyAnnotations: artifacts.privacyAnnotations,
      });
      currentPageUrl = pageUrl;
    };

    for (const event of payload.events ?? []) {
      if (event.pageUrl && event.pageUrl !== currentPageUrl) {
        await recordNavigationStep(event.pageUrl);
      }

      const step = mapManualEventToStepInput(event);
      if (!step) {
        continue;
      }
      const artifacts = await this.captureStepArtifacts(
        session.cdp,
        session.cdpSessionId,
        step.action,
        step.selectors,
      );
      this.recordingManager.recordManualStep(session.recordingId, {
        ...step,
        screenshot: artifacts.screenshot,
        targetSnapshot: artifacts.targetSnapshot,
        privacyAnnotations: artifacts.privacyAnnotations,
      });
      currentPageUrl = step.pageUrl;
    }

    if (payload.url && payload.url !== currentPageUrl) {
      await recordNavigationStep(payload.url);
    }

    session.lastPageUrl = currentPageUrl;
  }

  private async attachToManualPage(cdp: CdpClient, targetId: string): Promise<string> {
    const attachResult = (await cdp.sendCommand('Target.attachToTarget', {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const cdpSessionId = attachResult.sessionId;

    await cdp.sendCommand('Page.enable', {}, cdpSessionId);
    await cdp.sendCommand('Runtime.enable', {}, cdpSessionId);
    await cdp.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: buildManualRecorderBootstrap() },
      cdpSessionId,
    );
    await evaluateExpression(cdp, cdpSessionId, buildManualRecorderBootstrap());

    return cdpSessionId;
  }
}
