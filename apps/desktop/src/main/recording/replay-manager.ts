import { EventEmitter } from 'events';
import crypto from 'crypto';
import type {
  Recording,
  ReplayOptions,
  ReplayRun,
  ReplayStatus,
} from '@accomplish_ai/agent-core/common';
import type { RecordingManager } from '@accomplish_ai/agent-core/recording/index.js';
import { recoverDevBrowserServer } from '../opencode/electron-options';
import { createDevBrowserPage, resolveBrowserWsEndpoint } from './browser-runtime';
import { CdpClient } from './cdp-client';
import { executeReplayStep } from './replay-step-executor';
import type { ReplayContext } from './replay-types';
import {
  buildCurrentStep,
  makeReplayPageName,
  normalizeReplayOptions,
  sleep,
} from './replay-utils';

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
        createDevBrowserPage(makeReplayPageName(run.id), recording.metadata.viewport),
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
              await executeReplayStep(cdp, cdpSessionId, recording, index, activeRun.options);
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
}
