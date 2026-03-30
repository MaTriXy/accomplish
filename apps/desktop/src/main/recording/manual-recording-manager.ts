import type {
  PrivacyAnnotation,
  Recording,
  RecordingAction,
  SelectorStrategy,
} from '@accomplish_ai/agent-core/common';
import type { RecordingManager } from '@accomplish_ai/agent-core/recording/index.js';
import { createConsoleLogger } from '@accomplish_ai/agent-core/utils/index.js';
import { recoverDevBrowserServer } from '../opencode/electron-options';
import {
  createDevBrowserPage,
  evaluateExpression,
  resolveBrowserWsEndpoint,
  waitForDocumentReady,
} from './browser-runtime';
import { CdpClient } from './cdp-client';
import { buildManualRecorderBootstrap } from './manual-recorder-bootstrap';
import {
  DEFAULT_VIEWPORT,
  MANUAL_RECORDER_POLL_MS,
  SCREENSHOT_QUALITY,
  type ManualDrainPayload,
  type ManualRecordingSession,
  type ManualStepArtifacts,
} from './manual-recording-types';
import {
  isMissingSessionError,
  mapManualEventToStepInput,
  normalizeStartUrl,
  shouldCaptureScreenshot,
} from './manual-recording-utils';
import {
  buildScreenshotMaskExpression,
  cleanupScreenshotMask,
  type ManualScreenshotMaskResult,
} from './manual-screenshot-mask';

const COMMAND_TIMEOUT_MS = 10_000;
const log = createConsoleLogger({ prefix: 'ManualRecordingManager' });

function makeManualPageName(recordingId: string): string {
  return `manual-recording-${recordingId}`;
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
        this.createManualPage(recording.id, recording.metadata.viewport ?? DEFAULT_VIEWPORT),
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

  private async createManualPage(
    recordingId: string,
    viewport: { width: number; height: number },
  ): Promise<{ pageName: string; targetId: string }> {
    const pageName = makeManualPageName(recordingId);
    const targetId = await createDevBrowserPage(pageName, viewport);
    return { pageName, targetId };
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
