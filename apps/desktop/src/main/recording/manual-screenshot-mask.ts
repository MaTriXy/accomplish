import type { PrivacyConfig, SelectorStrategy } from '@accomplish_ai/agent-core/common';
import { evaluateExpression } from './browser-runtime';
import { CdpClient } from './cdp-client';
import type { ManualScreenshotMaskResult } from './manual-recording-types';
import { buildSelectorResolver } from './replay-selector-resolver';

function serializeForEvaluation(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? 'undefined' : serialized)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const EMAIL_SENSITIVE_KEYS = ['email', 'e-mail'];
const SECRET_SENSITIVE_KEYS = [
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

function buildSensitiveMaskConfig(config: PrivacyConfig): {
  redactAllFormInputs: boolean;
  customSensitiveKeys: string[];
  captureScreenshots: boolean;
  blurAllScreenshots: boolean;
  redactEmails: boolean;
  redactSecrets: boolean;
} {
  if (!config.enabled) {
    return {
      redactAllFormInputs: false,
      customSensitiveKeys: [],
      captureScreenshots: config.captureScreenshots,
      blurAllScreenshots: false,
      redactEmails: false,
      redactSecrets: false,
    };
  }

  const customSensitiveKeys = config.customSensitiveKeys.filter((key) => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (
      !config.redactEmails &&
      EMAIL_SENSITIVE_KEYS.some((candidate) => normalized.includes(candidate))
    ) {
      return false;
    }
    if (
      !config.redactSecrets &&
      SECRET_SENSITIVE_KEYS.some((candidate) => normalized.includes(candidate))
    ) {
      return false;
    }
    return true;
  });

  return {
    redactAllFormInputs: config.redactAllFormInputs,
    customSensitiveKeys,
    captureScreenshots: config.captureScreenshots,
    blurAllScreenshots: config.captureScreenshots && config.blurAllScreenshots,
    redactEmails: config.redactEmails,
    redactSecrets: config.redactSecrets,
  };
}

export function buildScreenshotMaskExpression(
  selectors: SelectorStrategy[] | undefined,
  config: PrivacyConfig,
): string {
  const payload = serializeForEvaluation({
    selectors,
    ...buildSensitiveMaskConfig(config),
  });
  const selectorResolver = buildSelectorResolver(selectors);

  return `
    (() => {
      const payload = ${payload};
      ${selectorResolver}
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
        ...(payload.redactEmails ? ${serializeForEvaluation(EMAIL_SENSITIVE_KEYS)} : []),
        ...(payload.redactSecrets ? ${serializeForEvaluation(SECRET_SENSITIVE_KEYS)} : []),
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

      const targetElement = findElement();

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

export async function cleanupScreenshotMask(cdp: CdpClient, sessionId: string): Promise<void> {
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

export type { ManualScreenshotMaskResult };
