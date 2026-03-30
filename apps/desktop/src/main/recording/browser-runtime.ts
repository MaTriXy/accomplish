import { DEV_BROWSER_CDP_PORT, DEV_BROWSER_PORT } from '@accomplish_ai/agent-core/common';
import { CdpClient } from './cdp-client';

export const DEV_BROWSER_HOST = '127.0.0.1';
const HTTP_TIMEOUT_MS = 10_000;

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
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

export async function resolveBrowserWsEndpoint(): Promise<string> {
  const info = await fetchJson<{ webSocketDebuggerUrl: string }>(
    `http://${DEV_BROWSER_HOST}:${DEV_BROWSER_CDP_PORT}/json/version`,
  );
  if (!info.webSocketDebuggerUrl) {
    throw new Error('CDP endpoint missing webSocketDebuggerUrl');
  }
  return info.webSocketDebuggerUrl;
}

export async function createDevBrowserPage(
  name: string,
  viewport: { width: number; height: number },
): Promise<string> {
  const result = await fetchJson<{ targetId: string }>(
    `http://${DEV_BROWSER_HOST}:${DEV_BROWSER_PORT}/pages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, viewport }),
    },
  );

  if (!result.targetId) {
    throw new Error(`Failed to create dev-browser page: ${name}`);
  }

  return result.targetId;
}

export async function evaluateExpression<T>(
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

export async function waitForDocumentReady(
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
