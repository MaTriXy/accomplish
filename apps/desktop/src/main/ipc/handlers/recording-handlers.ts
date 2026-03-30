import { BrowserWindow, dialog } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { handle, assertTrustedWindow } from './utils';
import type {
  PrivacyConfig,
  ReplayRun,
  RecordingUpdateInput,
  ReplayOptions,
} from '@accomplish_ai/agent-core/common';
import { getManualRecordingManager, getRecordingManager, getReplayManager } from '../../recording';

let replayUpdateListener: ((run: ReplayRun) => void) | null = null;

export function registerRecordingHandlers(): void {
  const recordingManager = getRecordingManager();
  const manualRecordingManager = getManualRecordingManager();
  const replayManager = getReplayManager();

  if (replayUpdateListener) {
    replayManager.off('replay:update', replayUpdateListener);
  }

  replayUpdateListener = (run) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('recording:replay-update', run);
      }
    }
  };
  replayManager.on('replay:update', replayUpdateListener);

  handle('recording:list', async (_event: IpcMainInvokeEvent) => {
    return recordingManager.listRecordings();
  });

  handle('recording:get', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return recordingManager.getRecording(recordingId);
  });

  handle('recording:list-replays', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return replayManager.listReplayRuns(recordingId);
  });

  handle(
    'recording:update',
    async (_event: IpcMainInvokeEvent, recordingId: string, input: RecordingUpdateInput) => {
      return recordingManager.updateRecording(recordingId, input);
    },
  );

  handle('recording:get-privacy-config', async (_event: IpcMainInvokeEvent) => {
    return recordingManager.getPrivacyConfig();
  });

  handle(
    'recording:set-privacy-config',
    async (_event: IpcMainInvokeEvent, config: PrivacyConfig) => {
      return recordingManager.setPrivacyConfig(config);
    },
  );

  handle('recording:get-active-for-task', async (_event: IpcMainInvokeEvent, taskId: string) => {
    return recordingManager.getActiveRecordingForTask(taskId);
  });

  handle('recording:get-replay', async (_event: IpcMainInvokeEvent, runId: string) => {
    return replayManager.getReplay(runId);
  });

  handle('recording:get-active-replay', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return replayManager.getActiveReplayForRecording(recordingId);
  });

  handle(
    'recording:start-agent',
    async (_event: IpcMainInvokeEvent, taskId: string, name?: string) => {
      return recordingManager.startAgentRecording(taskId, name);
    },
  );

  handle(
    'recording:start-manual',
    async (_event: IpcMainInvokeEvent, name?: string, startUrl?: string) => {
      return manualRecordingManager.startRecording(name, startUrl);
    },
  );

  handle('recording:stop', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return recordingManager.stopRecording(recordingId);
  });

  handle('recording:stop-manual', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return manualRecordingManager.stopRecording(recordingId);
  });

  handle(
    'recording:replay:start',
    async (_event: IpcMainInvokeEvent, recordingId: string, options?: Partial<ReplayOptions>) => {
      return replayManager.startReplay(recordingId, options);
    },
  );

  handle('recording:replay:cancel', async (_event: IpcMainInvokeEvent, runId: string) => {
    return replayManager.cancelReplay(runId);
  });

  handle('recording:replay:pause', async (_event: IpcMainInvokeEvent, runId: string) => {
    return replayManager.pauseReplay(runId);
  });

  handle('recording:replay:resume', async (_event: IpcMainInvokeEvent, runId: string) => {
    return replayManager.resumeReplay(runId);
  });

  handle('recording:replay:step', async (_event: IpcMainInvokeEvent, runId: string) => {
    return replayManager.stepReplay(runId);
  });

  handle('recording:delete', async (_event: IpcMainInvokeEvent, recordingId: string) => {
    return recordingManager.deleteRecording(recordingId);
  });

  handle('recording:export', async (event: IpcMainInvokeEvent, recordingId: string) => {
    const window = assertTrustedWindow(BrowserWindow.fromWebContents(event.sender));
    const recording = recordingManager.getRecording(recordingId);
    if (!recording) {
      throw new Error('Recording not found');
    }

    const result = await dialog.showSaveDialog(window, {
      defaultPath: recordingManager.getSuggestedExportFileName(recordingId, 'zip'),
      filters: [
        {
          name: 'Accomplish Recording Bundles',
          extensions: ['zip'],
        },
        {
          name: 'Accomplish Recording JSON',
          extensions: ['json'],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return recordingManager.exportRecording(recordingId, result.filePath);
  });

  handle('recording:import', async (event: IpcMainInvokeEvent) => {
    const window = assertTrustedWindow(BrowserWindow.fromWebContents(event.sender));
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Accomplish Recording Bundles',
          extensions: ['zip'],
        },
        {
          name: 'Accomplish Recording Files',
          extensions: ['zip', 'json'],
        },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return recordingManager.importRecording(result.filePaths[0]);
  });
}
