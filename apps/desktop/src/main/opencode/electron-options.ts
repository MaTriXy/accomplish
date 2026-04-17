import { app } from 'electron';
import path from 'path';
import { DEV_BROWSER_PORT, ensureDevBrowserServer } from '@accomplish_ai/agent-core';
import type { TaskCallbacks } from '@accomplish_ai/agent-core';
import { getLogCollector } from '../logging';
import { getBundledNodePaths } from '../utils/bundled-node';

const BROWSER_RECOVERY_COOLDOWN_MS = 30_000;

let browserEnsurePromise: Promise<void> | null = null;
let lastBrowserRecoveryAt = 0;

function logOC(level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) {
  try {
    const collector = getLogCollector();
    if (collector?.log) {
      collector.log(level, 'opencode', msg, data);
    }
  } catch {
    // Best-effort logging only.
  }
}

function getDesktopMcpToolsPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mcp-tools');
  }

  return path.join(app.getAppPath(), '..', '..', 'packages', 'agent-core', 'mcp-tools');
}

async function ensureBrowserServer(callbacks?: Pick<TaskCallbacks, 'onProgress'>): Promise<void> {
  if (browserEnsurePromise) {
    return browserEnsurePromise;
  }

  browserEnsurePromise = ensureDevBrowserServer(
    {
      mcpToolsPath: getDesktopMcpToolsPath(),
      bundledNodeBinPath: getBundledNodePaths()?.binDir,
      devBrowserPort: DEV_BROWSER_PORT,
    },
    callbacks?.onProgress,
  )
    .then(() => undefined)
    .finally(() => {
      browserEnsurePromise = null;
    });

  return browserEnsurePromise;
}

export async function recoverDevBrowserServer(
  callbacks?: Pick<TaskCallbacks, 'onProgress'>,
  options?: { reason?: string; force?: boolean },
): Promise<boolean> {
  const now = Date.now();
  const force = options?.force === true;

  if (!force && now - lastBrowserRecoveryAt < BROWSER_RECOVERY_COOLDOWN_MS) {
    logOC('INFO', `[Browser] Recovery skipped due to cooldown (${BROWSER_RECOVERY_COOLDOWN_MS}ms)`);
    return false;
  }

  const reason = options?.reason || 'Browser connection issue detected. Reconnecting browser...';
  callbacks?.onProgress?.({ stage: 'browser-recovery', message: reason });

  await ensureBrowserServer(callbacks);

  lastBrowserRecoveryAt = Date.now();
  callbacks?.onProgress?.({ stage: 'browser-recovery', message: 'Browser reconnected.' });
  return true;
}
