import type { Recording, SelectorStrategy } from '@accomplish_ai/agent-core/common';
import { evaluateExpression, waitForDocumentReady } from './browser-runtime';
import { CdpClient } from './cdp-client';
import { buildSelectorResolver } from './replay-selector-resolver';
import { serializeForEvaluation, sleep } from './replay-utils';

export async function waitForRecordedCondition(
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
    await waitForDocumentReady(cdp, sessionId, timeoutMs);
    return;
  }

  if (action.condition.type === 'networkIdle') {
    await waitForDocumentReady(cdp, sessionId, timeoutMs);
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
