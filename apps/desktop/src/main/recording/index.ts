import {
  createRecordingManager,
  type RecordingManager,
} from '@accomplish_ai/agent-core/recording/index.js';
import { ManualRecordingManager } from './manual-recording-manager';
import { ReplayManager } from './replay-manager';

let recordingManager: RecordingManager | null = null;
let replayManager: ReplayManager | null = null;
let manualRecordingManager: ManualRecordingManager | null = null;

export function getRecordingManager(): RecordingManager {
  if (!recordingManager) {
    recordingManager = createRecordingManager();
  }

  return recordingManager;
}

export function getReplayManager(): ReplayManager {
  if (!replayManager) {
    replayManager = new ReplayManager(getRecordingManager());
  }

  return replayManager;
}

export function getManualRecordingManager(): ManualRecordingManager {
  if (!manualRecordingManager) {
    manualRecordingManager = new ManualRecordingManager(getRecordingManager());
  }

  return manualRecordingManager;
}
