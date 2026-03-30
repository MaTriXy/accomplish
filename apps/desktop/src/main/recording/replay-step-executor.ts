import path from 'path';
import type { Recording, ReplayOptions } from '@accomplish_ai/agent-core/common';
import { evaluateExpression, waitForDocumentReady } from './browser-runtime';
import { CdpClient } from './cdp-client';
import { dispatchKeyboardInput, dispatchMouseClick, dispatchMouseMove } from './replay-input';
import {
  buildSelectorResolver,
  resolveElementNodeId,
  resolveElementPoint,
} from './replay-selector-resolver';
import {
  assertNeverAction,
  buildUploadParameterId,
  buildUploadParameterName,
  parseUploadPathList,
  serializeForEvaluation,
} from './replay-utils';
import { waitForRecordedCondition } from './replay-waits';

export function resolveParameterValue(
  recording: Recording,
  value: string,
  overrides: Record<string, string>,
): string {
  let nextValue = value;

  for (const parameter of recording.parameters) {
    const replacement =
      overrides[parameter.id] ?? overrides[parameter.name] ?? parameter.defaultValue;
    if (replacement === undefined) {
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
    return parameterPaths
      .map((filePath) => resolveParameterValue(recording, filePath, overrides).trim())
      .filter((filePath) => Boolean(filePath) && path.isAbsolute(filePath));
  }

  return step.action.fileNames
    .map((fileName) => resolveParameterValue(recording, fileName, overrides).trim())
    .filter((filePath) => Boolean(filePath) && path.isAbsolute(filePath));
}

export async function executeReplayStep(
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
      await waitForDocumentReady(cdp, sessionId, options.stepTimeoutMs);
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
      const point = await resolveElementPoint(cdp, sessionId, step.selectors);
      if (!point) {
        throw new Error('Target element not found');
      }
      await dispatchMouseMove(cdp, sessionId, point);
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
      await waitForRecordedCondition(
        cdp,
        sessionId,
        recording,
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
