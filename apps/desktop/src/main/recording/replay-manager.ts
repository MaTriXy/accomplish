import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import {
  DEV_BROWSER_CDP_PORT,
  DEV_BROWSER_PORT,
  type Recording,
  type ReplayOptions,
  type ReplayRun,
  type ReplayStatus,
  type ReplayStepState,
  type SelectorStrategy,
} from '@accomplish_ai/agent-core/common';
import type { RecordingManager } from '@accomplish_ai/agent-core/recording/index.js';
import { recoverDevBrowserServer } from '../opencode/electron-options';

const DEV_BROWSER_HOST = '127.0.0.1';
const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  speed: 1,
  parameters: {},
  errorStrategy: 'abort',
  stepTimeoutMs: 15_000,
  maxRetries: 2,
};
const COMMAND_TIMEOUT_MS = 10_000;

function serializeForEvaluation(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? 'undefined' : serialized)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function assertNeverAction(action: never): never {
  throw new Error(`Unsupported replay action: ${(action as { type?: string }).type ?? 'unknown'}`);
}

interface ReplayContext {
  runId: string;
  cancelled: boolean;
  paused: boolean;
  stepMode: boolean;
  stepBudget: number;
  resumePromise: Promise<void> | null;
  resolveResume: (() => void) | null;
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

interface Point {
  x: number;
  y: number;
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

function normalizeReplayOptions(options?: Partial<ReplayOptions>): ReplayOptions {
  return {
    speed:
      typeof options?.speed === 'number' && options.speed >= 0
        ? options.speed
        : DEFAULT_REPLAY_OPTIONS.speed,
    parameters: options?.parameters ?? DEFAULT_REPLAY_OPTIONS.parameters,
    errorStrategy: options?.errorStrategy ?? DEFAULT_REPLAY_OPTIONS.errorStrategy,
    stepTimeoutMs: options?.stepTimeoutMs ?? DEFAULT_REPLAY_OPTIONS.stepTimeoutMs,
    maxRetries:
      typeof options?.maxRetries === 'number' && options.maxRetries >= 0
        ? Math.floor(options.maxRetries)
        : DEFAULT_REPLAY_OPTIONS.maxRetries,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReplayPageName(runId: string): string {
  return `replay-${runId}`;
}

function buildCurrentStep(recording: Recording, stepIndex: number): ReplayStepState | undefined {
  const step = recording.steps[stepIndex];
  if (!step) {
    return undefined;
  }

  return {
    index: step.index,
    stepId: step.id,
    actionType: step.action.type,
    pageUrl: step.pageUrl,
  };
}

function buildUploadParameterId(stepId: string): string {
  return `upload-${stepId}`;
}

function buildUploadParameterName(stepIndex: number): string {
  return `upload_step_${stepIndex + 1}`;
}

function parseUploadPathList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Ignore JSON parsing failures and fall back to newline-delimited input.
  }

  return trimmed
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSelectorResolver(selectors?: SelectorStrategy[]): string {
  const selectorsJson = serializeForEvaluation(selectors ?? []);
  return `
    const selectors = ${selectorsJson};
    const readRolePayload = (value) => {
      if (!value) {
        return null;
      }
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed.role === 'string') {
          return {
            role: parsed.role,
            name: typeof parsed.name === 'string' ? parsed.name : null,
          };
        }
      } catch {}
      return { role: String(value), name: null };
    };
    const findByXPath = (needle) => {
      if (!needle) {
        return null;
      }
      const match = document.evaluate(
        String(needle),
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
      return match instanceof Element ? match : null;
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
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') {
          return 'checkbox';
        }
        if (type === 'radio') {
          return 'radio';
        }
        if (type === 'submit' || type === 'button' || type === 'reset') {
          return 'button';
        }
        return 'textbox';
      }
      return null;
    };
    const getAccessibleName = (element) => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim();
      }
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy
          .split(/\\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ')
          .trim();
        if (text) {
          return text;
        }
      }
      if ('labels' in element && element.labels) {
        const text = Array.from(element.labels)
          .map((label) => (label.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        if (text) {
          return text;
        }
      }
      const fallback = [
        element.getAttribute('title'),
        element.getAttribute('placeholder'),
        'value' in element ? String(element.value || '').trim() : '',
        (element.textContent || '').trim(),
      ].find((value) => value && value.trim());
      return fallback ? fallback.trim() : '';
    };
    const findByText = (needle) => {
      if (!needle) {
        return null;
      }
      const normalizedNeedle = String(needle).trim();
      if (!normalizedNeedle) {
        return null;
      }
      const candidates = Array.from(document.querySelectorAll('body *'));
      return candidates.find((candidate) => {
        const text = (candidate.textContent || '').trim();
        return text === normalizedNeedle || text.includes(normalizedNeedle);
      }) || null;
    };
    const findByAriaRole = (value) => {
      const payload = readRolePayload(value);
      if (!payload) {
        return null;
      }
      const expectedRole = payload.role.trim();
      const expectedName = payload.name ? payload.name.trim() : '';
      if (!expectedRole) {
        return null;
      }
      const candidates = Array.from(document.querySelectorAll('body *'));
      return (
        candidates.find((candidate) => {
          const role = inferRole(candidate);
          if (role !== expectedRole) {
            return false;
          }
          if (!expectedName) {
            return true;
          }
          const name = getAccessibleName(candidate);
          return name === expectedName || name.includes(expectedName);
        }) || null
      );
    };
    const findElement = () => {
      for (const selector of selectors) {
        try {
          if (selector.type === 'css') {
            const match = document.querySelector(selector.value);
            if (match) {
              return match;
            }
          }
          if (selector.type === 'xpath') {
            const match = findByXPath(selector.value);
            if (match) {
              return match;
            }
          }
          if (selector.type === 'text') {
            const match = findByText(selector.value);
            if (match) {
              return match;
            }
          }
          if (selector.type === 'aria-label') {
            const match = document.querySelector('[aria-label="' + CSS.escape(selector.value) + '"]');
            if (match) {
              return match;
            }
          }
          if (selector.type === 'test-id') {
            const match = document.querySelector('[data-testid="' + CSS.escape(selector.value) + '"]');
            if (match) {
              return match;
            }
          }
          if (selector.type === 'aria-role') {
            const match = findByAriaRole(selector.value);
            if (match) {
              return match;
            }
          }
          if (selector.type === 'ref') {
            const match =
              document.querySelector('[data-ref="' + CSS.escape(selector.value) + '"]') ||
              document.querySelector('[data-testid="' + CSS.escape(selector.value) + '"]') ||
              document.getElementById(selector.value);
            if (match) {
              return match;
            }
          }
        } catch {
          continue;
        }
      }
      return null;
    };
  `;
}

function resolveParameterValue(
  recording: Recording,
  value: string,
  overrides: Record<string, string>,
): string {
  let nextValue = value;

  for (const parameter of recording.parameters) {
    const replacement =
      overrides[parameter.id] ?? overrides[parameter.name] ?? parameter.defaultValue;
    if (!replacement) {
      continue;
    }

    const byId = `{{${parameter.id}}}`;
    const byName = `{{${parameter.name}}}`;
    nextValue = nextValue.split(byId).join(replacement).split(byName).join(replacement);
  }

  return nextValue;
}

function resolveUploadFilePaths(
  recording: Recording,
  step: Recording['steps'][number],
  overrides: Record<string, string>,
): string[] {
  if (step.action.type !== 'upload') {
    return [];
  }

  const uploadOverride =
    overrides[buildUploadParameterId(step.id)] ?? overrides[buildUploadParameterName(step.index)];
  const parameterPaths = uploadOverride ? parseUploadPathList(uploadOverride) : [];
  if (parameterPaths.length > 0) {
    return parameterPaths;
  }

  return step.action.fileNames
    .map((fileName) => resolveParameterValue(recording, fileName, overrides).trim())
    .filter((filePath) => Boolean(filePath) && path.isAbsolute(filePath));
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

async function createReplayPage(
  runId: string,
  viewport: { width: number; height: number },
): Promise<string> {
  const result = await fetchJson<{ targetId: string }>(
    `http://${DEV_BROWSER_HOST}:${DEV_BROWSER_PORT}/pages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: makeReplayPageName(runId), viewport }),
    },
  );

  if (!result.targetId) {
    throw new Error('Failed to create replay page');
  }

  return result.targetId;
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

async function resolveElementPoint(
  cdp: CdpClient,
  sessionId: string,
  selectors?: SelectorStrategy[],
): Promise<Point | null> {
  return evaluateExpression<Point | null>(
    cdp,
    sessionId,
    `
      (() => {
        ${buildSelectorResolver(selectors)}
        const element = findElement();
        if (!element) {
          return null;
        }
        if (element instanceof HTMLElement) {
          element.scrollIntoView({ block: 'center', inline: 'center' });
        }
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      })()
    `,
  );
}

function getMouseButtonName(button: 'left' | 'middle' | 'right'): 'left' | 'middle' | 'right' {
  return button;
}

async function dispatchMouseClick(
  cdp: CdpClient,
  sessionId: string,
  point: Point,
  button: 'left' | 'middle' | 'right',
  clickCount: number,
): Promise<void> {
  const normalizedClickCount = Math.max(1, clickCount);
  const buttonName = getMouseButtonName(button);

  await cdp.sendCommand(
    'Input.dispatchMouseEvent',
    {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: buttonName,
      buttons: 0,
      clickCount: 0,
    },
    sessionId,
  );

  for (let index = 0; index < normalizedClickCount; index += 1) {
    const currentClickCount = index + 1;
    await cdp.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: buttonName,
        buttons: button === 'left' ? 1 : button === 'middle' ? 4 : 2,
        clickCount: currentClickCount,
      },
      sessionId,
    );
    await cdp.sendCommand(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button: buttonName,
        buttons: 0,
        clickCount: currentClickCount,
      },
      sessionId,
    );
  }
}

function getCdpModifiers(modifiers: string[]): number {
  const normalizedModifiers = modifiers.map((modifier) => modifier.toLowerCase());
  let flags = 0;
  if (normalizedModifiers.includes('alt')) {
    flags |= 1;
  }
  if (normalizedModifiers.includes('control') || normalizedModifiers.includes('ctrl')) {
    flags |= 2;
  }
  if (
    normalizedModifiers.includes('meta') ||
    normalizedModifiers.includes('cmd') ||
    normalizedModifiers.includes('command')
  ) {
    flags |= 4;
  }
  if (normalizedModifiers.includes('shift')) {
    flags |= 8;
  }
  return flags;
}

function getKeyDefinition(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
} {
  const knownKeys: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> =
    {
      Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
      ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
      ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
      Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
      ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    };
  const known = knownKeys[key];
  if (known) {
    return { key, ...known };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const isDigit = /[0-9]/.test(key);
    return {
      key,
      code: isDigit ? `Digit${key}` : `Key${upper}`,
      windowsVirtualKeyCode: charCode,
      text: key,
    };
  }
  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
  };
}

async function dispatchKeyboardInput(
  cdp: CdpClient,
  sessionId: string,
  key: string,
  modifiers: string[],
): Promise<void> {
  const definition = getKeyDefinition(key);
  const cdpModifiers = getCdpModifiers(modifiers);
  const shouldSendText = Boolean(definition.text) && (cdpModifiers & (1 | 2 | 4)) === 0;

  await cdp.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: shouldSendText ? 'keyDown' : 'rawKeyDown',
      key: definition.key,
      code: definition.code,
      text: shouldSendText ? definition.text : undefined,
      unmodifiedText: shouldSendText ? definition.text : undefined,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: cdpModifiers,
    },
    sessionId,
  );
  await cdp.sendCommand(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
      modifiers: cdpModifiers,
    },
    sessionId,
  );
}

async function resolveElementNodeId(
  cdp: CdpClient,
  sessionId: string,
  selectors?: SelectorStrategy[],
): Promise<number | null> {
  const result = (await cdp.sendCommand(
    'Runtime.evaluate',
    {
      expression: `
        (() => {
          ${buildSelectorResolver(selectors)}
          return findElement();
        })()
      `,
      awaitPromise: true,
      returnByValue: false,
    },
    sessionId,
  )) as {
    result?: { objectId?: string; subtype?: string; type?: string };
    exceptionDetails?: { text?: string };
  };

  if (result.exceptionDetails?.text) {
    throw new Error(result.exceptionDetails.text);
  }

  const objectId = result.result?.objectId;
  if (!objectId || result.result?.subtype === 'null' || result.result?.type === 'undefined') {
    return null;
  }

  try {
    const node = (await cdp.sendCommand('DOM.requestNode', { objectId }, sessionId)) as {
      nodeId?: number;
    };
    return typeof node.nodeId === 'number' ? node.nodeId : null;
  } finally {
    await cdp.sendCommand('Runtime.releaseObject', { objectId }, sessionId).catch(() => {});
  }
}

export class ReplayManager extends EventEmitter {
  private readonly runs = new Map<string, ReplayRun>();
  private readonly contexts = new Map<string, ReplayContext>();

  constructor(private readonly recordingManager: RecordingManager) {
    super();
  }

  getReplay(runId: string): ReplayRun | null {
    return this.runs.get(runId) ?? this.recordingManager.getReplayRun(runId);
  }

  listReplayRuns(recordingId: string): ReplayRun[] {
    const persistedRuns = this.recordingManager.listReplayRuns(recordingId);
    const activeRuns = Array.from(this.runs.values()).filter(
      (run) => run.recordingId === recordingId,
    );
    const mergedRuns = new Map<string, ReplayRun>();

    for (const run of persistedRuns) {
      mergedRuns.set(run.id, run);
    }
    for (const run of activeRuns) {
      mergedRuns.set(run.id, run);
    }

    return Array.from(mergedRuns.values()).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  getActiveReplayForRecording(recordingId: string): ReplayRun | null {
    return (
      Array.from(this.runs.values()).find(
        (run) =>
          run.recordingId === recordingId && (run.status === 'running' || run.status === 'paused'),
      ) ?? null
    );
  }

  async startReplay(recordingId: string, options?: Partial<ReplayOptions>): Promise<ReplayRun> {
    const existing = this.getActiveReplayForRecording(recordingId);
    if (existing) {
      return existing;
    }

    const recording = this.recordingManager.getRecording(recordingId);
    if (!recording) {
      throw new Error('Recording not found');
    }

    await recoverDevBrowserServer(undefined, {
      force: true,
      reason: 'Preparing browser for replay...',
    });

    const normalizedOptions = normalizeReplayOptions(options);
    const isStepMode = normalizedOptions.speed === 0;
    const now = new Date().toISOString();
    const run: ReplayRun = {
      id: crypto.randomUUID(),
      recordingId: recording.id,
      recordingName: recording.name,
      status: isStepMode ? 'paused' : 'running',
      currentStepIndex: 0,
      totalSteps: recording.steps.length,
      startedAt: now,
      updatedAt: now,
      options: normalizedOptions,
      currentStep: buildCurrentStep(recording, 0),
    };

    this.runs.set(run.id, run);
    this.recordingManager.saveReplayRun(run);
    this.contexts.set(run.id, {
      runId: run.id,
      cancelled: false,
      paused: isStepMode,
      stepMode: isStepMode,
      stepBudget: 0,
      ...this.createResumeState(isStepMode),
    });
    this.emitUpdate(run);

    void this.executeReplay(run, recording).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.finishRun(run.id, 'failed', message);
    });

    return run;
  }

  async cancelReplay(runId: string): Promise<ReplayRun | null> {
    const context = this.contexts.get(runId);
    if (context) {
      context.cancelled = true;
      context.resolveResume?.();
    }

    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }

    if (run.status === 'running' || run.status === 'paused') {
      this.finishRun(runId, 'cancelled');
    }

    return this.runs.get(runId) ?? this.recordingManager.getReplayRun(runId);
  }

  pauseReplay(runId: string): ReplayRun | null {
    const context = this.contexts.get(runId);
    const run = this.runs.get(runId);
    if (!context || !run || run.status !== 'running') {
      return run ?? null;
    }

    this.ensureResumeState(context);
    context.paused = true;
    context.stepBudget = 0;
    return this.updateRun(runId, { status: 'paused' });
  }

  resumeReplay(runId: string): ReplayRun | null {
    const context = this.contexts.get(runId);
    const run = this.runs.get(runId);
    if (!context || !run || run.status !== 'paused') {
      return run ?? null;
    }

    context.stepMode = false;
    context.stepBudget = 0;
    context.paused = false;
    this.releaseResumeState(context);
    return this.updateRun(runId, {
      status: 'running',
      options: {
        ...run.options,
        speed: run.options.speed === 0 ? 1 : run.options.speed,
      },
    });
  }

  stepReplay(runId: string): ReplayRun | null {
    const context = this.contexts.get(runId);
    const run = this.runs.get(runId);
    if (!context || !run || (run.status !== 'paused' && run.status !== 'running')) {
      return run ?? null;
    }

    context.stepMode = true;
    context.stepBudget += 1;
    context.paused = false;
    this.releaseResumeState(context);
    return this.updateRun(runId, {
      status: 'running',
      options: {
        ...run.options,
        speed: 0,
      },
    });
  }

  private emitUpdate(run: ReplayRun): void {
    this.recordingManager.saveReplayRun(run);
    this.emit('replay:update', { ...run });
  }

  private updateRun(runId: string, patch: Partial<ReplayRun>): ReplayRun {
    const existing = this.runs.get(runId);
    if (!existing) {
      throw new Error(`Replay run ${runId} not found`);
    }

    const nextRun: ReplayRun = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(runId, nextRun);
    this.emitUpdate(nextRun);
    return nextRun;
  }

  private finishRun(runId: string, status: ReplayStatus, error?: string): ReplayRun | null {
    const existing = this.runs.get(runId);
    if (!existing) {
      return null;
    }

    const now = new Date().toISOString();
    const nextRun: ReplayRun = {
      ...existing,
      status,
      error,
      updatedAt: now,
      completedAt: now,
    };
    this.runs.set(runId, nextRun);
    this.contexts.delete(runId);
    this.emitUpdate(nextRun);
    return nextRun;
  }

  private createResumeState(
    paused: boolean,
  ): Pick<ReplayContext, 'resumePromise' | 'resolveResume'> {
    if (!paused) {
      return {
        resumePromise: null,
        resolveResume: null,
      };
    }

    let resolveResume: (() => void) | null = null;
    const resumePromise = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });

    return { resumePromise, resolveResume };
  }

  private ensureResumeState(context: ReplayContext): void {
    if (context.resumePromise) {
      return;
    }

    const resumeState = this.createResumeState(true);
    context.resumePromise = resumeState.resumePromise;
    context.resolveResume = resumeState.resolveResume;
  }

  private releaseResumeState(context: ReplayContext): void {
    context.resolveResume?.();
    context.resumePromise = null;
    context.resolveResume = null;
  }

  private async waitForReplayTurn(runId: string, context: ReplayContext): Promise<void> {
    while (!context.cancelled) {
      if (context.stepMode) {
        if (context.stepBudget > 0) {
          context.stepBudget -= 1;
          return;
        }

        context.paused = true;
        this.ensureResumeState(context);
        if (this.runs.get(runId)?.status !== 'paused') {
          this.updateRun(runId, { status: 'paused' });
        }
        await context.resumePromise;
        continue;
      }

      if (context.paused) {
        this.ensureResumeState(context);
        if (this.runs.get(runId)?.status !== 'paused') {
          this.updateRun(runId, { status: 'paused' });
        }
        await context.resumePromise;
        continue;
      }

      return;
    }
  }

  private async executeReplay(run: ReplayRun, recording: Recording): Promise<void> {
    const context = this.contexts.get(run.id);
    if (!context) {
      return;
    }

    const cdp = new CdpClient();
    let cdpSessionId: string | null = null;
    let targetId: string | null = null;

    try {
      const [wsEndpoint, resolvedTargetId] = await Promise.all([
        resolveBrowserWsEndpoint(),
        createReplayPage(run.id, recording.metadata.viewport),
      ]);
      targetId = resolvedTargetId;

      await cdp.connect(wsEndpoint);
      const attachResult = (await cdp.sendCommand('Target.attachToTarget', {
        targetId: resolvedTargetId,
        flatten: true,
      })) as { sessionId: string };
      cdpSessionId = attachResult.sessionId;

      await cdp.sendCommand('Page.enable', {}, cdpSessionId);
      await cdp.sendCommand('Runtime.enable', {}, cdpSessionId);
      await cdp.sendCommand('DOM.enable', {}, cdpSessionId);
      await cdp.sendCommand(
        'Emulation.setDeviceMetricsOverride',
        {
          width: recording.metadata.viewport.width,
          height: recording.metadata.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        cdpSessionId,
      );

      for (let index = 0; index < recording.steps.length; index += 1) {
        const activeRun = this.runs.get(run.id) ?? run;
        if (context.cancelled) {
          this.finishRun(run.id, 'cancelled');
          return;
        }

        await this.waitForReplayTurn(run.id, context);
        if (context.cancelled) {
          this.finishRun(run.id, 'cancelled');
          return;
        }

        const step = recording.steps[index];
        this.updateRun(run.id, {
          status: 'running',
          currentStepIndex: index,
          currentStep: buildCurrentStep(recording, index),
        });

        if (index > 0 && activeRun.options.speed > 0) {
          const previous = recording.steps[index - 1];
          const delay =
            Math.max(step.timestampMs - previous.timestampMs, 0) / activeRun.options.speed;
          if (delay > 0) {
            await sleep(Math.min(delay, 2_000));
          }
        }

        try {
          const maxAttempts =
            activeRun.options.errorStrategy === 'retry'
              ? Math.max(activeRun.options.maxRetries, 0) + 1
              : 1;
          let attempt = 0;
          while (attempt < maxAttempts) {
            try {
              await this.executeStep(cdp, cdpSessionId, recording, index, activeRun.options);
              break;
            } catch (error) {
              attempt += 1;
              if (attempt >= maxAttempts) {
                throw error;
              }
            }
          }
        } catch (error) {
          if (activeRun.options.errorStrategy === 'skip') {
            continue;
          }
          throw error;
        }

        if (context.stepMode && context.stepBudget <= 0 && index < recording.steps.length - 1) {
          context.paused = true;
          this.ensureResumeState(context);
          this.updateRun(run.id, { status: 'paused' });
        }
      }

      this.updateRun(run.id, {
        currentStepIndex: recording.steps.length,
        currentStep:
          recording.steps.length > 0
            ? buildCurrentStep(recording, recording.steps.length - 1)
            : undefined,
      });
      this.finishRun(run.id, 'completed');
    } finally {
      if (targetId) {
        await cdp.sendCommand('Target.closeTarget', { targetId }).catch(() => {});
      }
      if (cdpSessionId) {
        await cdp.sendCommand('Page.stopLoading', {}, cdpSessionId).catch(() => {});
      }
      await cdp.disconnect().catch(() => {});
    }
  }

  private async executeStep(
    cdp: CdpClient,
    sessionId: string,
    recording: Recording,
    stepIndex: number,
    options: ReplayOptions,
  ): Promise<void> {
    const step = recording.steps[stepIndex];
    const { action } = step;

    switch (action.type) {
      case 'navigate': {
        const url = resolveParameterValue(recording, action.url, options.parameters);
        await cdp.sendCommand('Page.navigate', { url }, sessionId);
        await this.waitForDocumentReady(cdp, sessionId, options.stepTimeoutMs);
        return;
      }
      case 'click': {
        const resolvedPoint = await resolveElementPoint(cdp, sessionId, step.selectors);
        const point =
          typeof action.x === 'number' && typeof action.y === 'number'
            ? { x: action.x, y: action.y }
            : resolvedPoint;
        if (!point) {
          throw new Error('Target element not found');
        }
        await dispatchMouseClick(cdp, sessionId, point, action.button, action.clickCount);
        return;
      }
      case 'fill': {
        const value = resolveParameterValue(recording, action.value, options.parameters);
        const result = await evaluateExpression<{ ok: boolean; error?: string }>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!element) {
                return { ok: false, error: 'Target element not found' };
              }
              const nextValue = ${serializeForEvaluation(value)};
              if ('value' in element) {
                element.value = nextValue;
              } else if (element.isContentEditable) {
                element.textContent = nextValue;
              } else {
                return { ok: false, error: 'Target element is not fillable' };
              }
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            })()
          `,
        );
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to fill target');
        }
        return;
      }
      case 'type': {
        const text = resolveParameterValue(recording, action.text, options.parameters);
        const result = await evaluateExpression<{ ok: boolean; error?: string }>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!element) {
                return { ok: false, error: 'Target element not found' };
              }
              const addition = ${serializeForEvaluation(text)};
              if ('value' in element) {
                element.value = String(element.value || '') + addition;
              } else if (element.isContentEditable) {
                element.textContent = String(element.textContent || '') + addition;
              } else {
                return { ok: false, error: 'Target element is not typable' };
              }
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            })()
          `,
        );
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to type into target');
        }
        return;
      }
      case 'select': {
        const values = action.values.map((value) =>
          resolveParameterValue(recording, value, options.parameters),
        );
        const result = await evaluateExpression<{ ok: boolean; error?: string }>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!(element instanceof HTMLSelectElement)) {
                return { ok: false, error: 'Target element is not a select' };
              }
              const values = ${serializeForEvaluation(values)};
              for (const option of Array.from(element.options)) {
                option.selected = values.includes(option.value) || values.includes(option.label);
              }
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            })()
          `,
        );
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to select value');
        }
        return;
      }
      case 'hover': {
        const result = await evaluateExpression<{ ok: boolean; error?: string }>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!element) {
                return { ok: false, error: 'Target element not found' };
              }
              element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
              element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              return { ok: true };
            })()
          `,
        );
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to hover target');
        }
        return;
      }
      case 'scroll': {
        if (action.target === 'viewport' || !step.selectors?.length) {
          await evaluateExpression(
            cdp,
            sessionId,
            `(() => { window.scrollBy(${action.deltaX}, ${action.deltaY}); return true; })()`,
          );
          return;
        }

        const result = await evaluateExpression<{ ok: boolean; error?: string }>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!element) {
                return { ok: false, error: 'Target element not found' };
              }
              element.scrollBy(${action.deltaX}, ${action.deltaY});
              return { ok: true };
            })()
          `,
        );
        if (!result.ok) {
          throw new Error(result.error ?? 'Failed to scroll target');
        }
        return;
      }
      case 'wait': {
        await this.waitForRecordedCondition(
          cdp,
          sessionId,
          step.selectors,
          action,
          options.stepTimeoutMs,
        );
        return;
      }
      case 'keypress': {
        await dispatchKeyboardInput(cdp, sessionId, action.key, action.modifiers);
        return;
      }
      case 'tool-call': {
        return;
      }
      case 'upload': {
        const filePaths = resolveUploadFilePaths(recording, step, options.parameters);
        if (filePaths.length === 0) {
          throw new Error(
            `Upload step ${step.index + 1} requires a file path in parameter ${buildUploadParameterName(
              step.index,
            )}`,
          );
        }

        const nodeId = await resolveElementNodeId(cdp, sessionId, step.selectors);
        if (!nodeId) {
          throw new Error('Upload target element not found');
        }

        await cdp.sendCommand('DOM.setFileInputFiles', { nodeId, files: filePaths }, sessionId);
        await evaluateExpression(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(step.selectors)}
              const element = findElement();
              if (!element) {
                return false;
              }
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()
          `,
        );
        return;
      }
      default: {
        assertNeverAction(action as never);
      }
    }
  }

  private async waitForDocumentReady(
    cdp: CdpClient,
    sessionId: string,
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const state = await evaluateExpression<string>(
        cdp,
        sessionId,
        `(() => document.readyState)()`,
      );
      if (state === 'complete' || state === 'interactive') {
        return;
      }
      await sleep(150);
    }
    throw new Error('Timed out waiting for page load');
  }

  private async waitForRecordedCondition(
    cdp: CdpClient,
    sessionId: string,
    selectors: SelectorStrategy[] | undefined,
    action: Recording['steps'][number]['action'] & { type: 'wait' },
    timeoutMs: number,
  ): Promise<void> {
    if (action.condition.type === 'timeout') {
      const duration =
        typeof action.condition.value === 'string'
          ? Number.parseInt(action.condition.value, 10)
          : action.durationMs;
      await sleep(Number.isFinite(duration) ? Math.max(duration, 0) : 250);
      return;
    }

    if (action.condition.type === 'selectorVisible' || action.condition.type === 'selectorHidden') {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const result = await evaluateExpression<'missing' | 'visible' | 'hidden'>(
          cdp,
          sessionId,
          `
            (() => {
              ${buildSelectorResolver(selectors)}
              const element = findElement();
              if (!element) {
                return 'missing';
              }
              const rect = element.getBoundingClientRect();
              const visible = rect.width > 0 && rect.height > 0;
              return visible ? 'visible' : 'hidden';
            })()
          `,
        );
        if (action.condition.type === 'selectorVisible' && result === 'visible') {
          return;
        }
        if (action.condition.type === 'selectorHidden' && result !== 'visible') {
          return;
        }
        await sleep(150);
      }

      throw new Error(`Timed out waiting for ${action.condition.type}`);
    }

    if (action.condition.type === 'navigation') {
      await this.waitForDocumentReady(cdp, sessionId, timeoutMs);
      return;
    }

    if (action.condition.type === 'networkIdle') {
      await this.waitForDocumentReady(cdp, sessionId, timeoutMs);
      await sleep(Math.min(500, timeoutMs));
      return;
    }

    if (action.condition.type === 'custom' && typeof action.condition.value === 'string') {
      const customCondition = action.condition.value;
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const result = await evaluateExpression<boolean>(
          cdp,
          sessionId,
          `
            (() => {
              try {
                const script = ${serializeForEvaluation(customCondition)};
                return Boolean(Function('"use strict"; return (' + script + ');')());
              } catch {
                return false;
              }
            })()
          `,
        );
        if (result) {
          return;
        }
        await sleep(150);
      }

      throw new Error('Timed out waiting for custom condition');
    }

    await sleep(Math.min(action.durationMs || 500, timeoutMs));
  }
}
