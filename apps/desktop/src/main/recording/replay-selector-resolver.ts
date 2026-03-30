import type { SelectorStrategy } from '@accomplish_ai/agent-core/common';
import { evaluateExpression } from './browser-runtime';
import { CdpClient } from './cdp-client';
import type { Point } from './replay-types';
import { serializeForEvaluation } from './replay-utils';

export function buildSelectorResolver(selectors?: SelectorStrategy[]): string {
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

export async function resolveElementPoint(
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

export async function resolveElementNodeId(
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
    await cdp.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}
