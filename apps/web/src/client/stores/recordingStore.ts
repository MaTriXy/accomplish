import { create } from 'zustand';
import type {
  Recording,
  RecordingUpdateInput,
  ReplayOptions,
  ReplayRun,
} from '@accomplish_ai/agent-core/common';
import { getAccomplish } from '../lib/accomplish';

function toRecordingErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface RecordingState {
  recordings: Recording[];
  selectedRecording: Recording | null;
  replayRuns: Record<string, ReplayRun>;
  isLoading: boolean;
  error: string | null;
  loadRecordings: () => Promise<void>;
  loadRecording: (recordingId: string) => Promise<Recording | null>;
  loadReplayRuns: (recordingId: string) => Promise<ReplayRun[]>;
  refreshActiveRecordingForTask: (taskId: string) => Promise<Recording | null>;
  refreshActiveReplayForRecording: (recordingId: string) => Promise<ReplayRun | null>;
  updateRecording: (recordingId: string, input: RecordingUpdateInput) => Promise<Recording>;
  startAgentRecording: (taskId: string, name?: string) => Promise<Recording>;
  startManualRecording: (name?: string, startUrl?: string) => Promise<Recording>;
  stopRecording: (recordingId: string) => Promise<Recording>;
  stopManualRecording: (recordingId: string) => Promise<Recording>;
  startReplay: (recordingId: string, options?: Partial<ReplayOptions>) => Promise<ReplayRun>;
  pauseReplay: (runId: string) => Promise<ReplayRun | null>;
  resumeReplay: (runId: string) => Promise<ReplayRun | null>;
  stepReplay: (runId: string) => Promise<ReplayRun | null>;
  cancelReplay: (runId: string) => Promise<ReplayRun | null>;
  applyReplayRun: (run: ReplayRun) => void;
  deleteRecording: (recordingId: string) => Promise<void>;
  exportRecording: (recordingId: string) => Promise<string | null>;
  importRecording: () => Promise<Recording | null>;
}

function upsertRecording(recordings: Recording[], next: Recording): Recording[] {
  return [next, ...recordings.filter((recording) => recording.id !== next.id)].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export const useRecordingStore = create<RecordingState>((set) => ({
  recordings: [],
  selectedRecording: null,
  replayRuns: {},
  isLoading: false,
  error: null,

  loadRecordings: async () => {
    const accomplish = getAccomplish();
    set({ isLoading: true, error: null });
    try {
      const recordings = await accomplish.listRecordings();
      set({ recordings, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: toRecordingErrorMessage(error, 'Failed to load recordings'),
      });
    }
  },

  loadRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.getRecording(recordingId);
      set((state) => ({
        selectedRecording: recording,
        recordings: recording ? upsertRecording(state.recordings, recording) : state.recordings,
        error: null,
      }));
      return recording;
    } catch (error) {
      set({
        selectedRecording: null,
        error: toRecordingErrorMessage(error, 'Failed to load recording'),
      });
      return null;
    }
  },

  loadReplayRuns: async (recordingId: string) => {
    const accomplish = getAccomplish();
    try {
      const runs = await accomplish.listReplayRuns(recordingId);
      set((state) => ({
        replayRuns: {
          ...state.replayRuns,
          ...Object.fromEntries(runs.map((run) => [run.id, run])),
        },
        error: null,
      }));
      return runs;
    } catch (error) {
      set({
        error: toRecordingErrorMessage(error, 'Failed to load replay history'),
      });
      return [];
    }
  },

  refreshActiveRecordingForTask: async (taskId: string) => {
    const accomplish = getAccomplish();
    const recording = await accomplish.getActiveRecordingForTask(taskId);
    if (recording) {
      set((state) => ({ recordings: upsertRecording(state.recordings, recording) }));
    }
    return recording;
  },

  refreshActiveReplayForRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    const run = await accomplish.getActiveReplayForRecording(recordingId);
    if (run) {
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
      }));
    }
    return run;
  },

  updateRecording: async (recordingId: string, input: RecordingUpdateInput) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.updateRecording(recordingId, input);
      set((state) => ({
        selectedRecording:
          state.selectedRecording?.id === recording.id ? recording : state.selectedRecording,
        recordings: upsertRecording(state.recordings, recording),
        error: null,
      }));
      return recording;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to update recording');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  startAgentRecording: async (taskId: string, name?: string) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.startAgentRecording(taskId, name);
      set((state) => ({
        recordings: upsertRecording(state.recordings, recording),
        error: null,
      }));
      return recording;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to start agent recording');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  startManualRecording: async (name?: string, startUrl?: string) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.startManualRecording(name, startUrl);
      set((state) => ({
        recordings: upsertRecording(state.recordings, recording),
        selectedRecording:
          state.selectedRecording?.id === recording.id ? recording : state.selectedRecording,
        error: null,
      }));
      return recording;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to start manual recording');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  stopRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.stopRecording(recordingId);
      set((state) => ({
        recordings: upsertRecording(state.recordings, recording),
        error: null,
      }));
      return recording;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to stop recording');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  stopManualRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    try {
      const recording = await accomplish.stopManualRecording(recordingId);
      set((state) => ({
        recordings: upsertRecording(state.recordings, recording),
        selectedRecording:
          state.selectedRecording?.id === recording.id ? recording : state.selectedRecording,
        error: null,
      }));
      return recording;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to stop manual recording');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  startReplay: async (recordingId: string, options?: Partial<ReplayOptions>) => {
    const accomplish = getAccomplish();
    try {
      const run = await accomplish.replayRecording(recordingId, options);
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
        error: null,
      }));
      return run;
    } catch (error) {
      const message = toRecordingErrorMessage(error, 'Failed to start replay');
      set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  pauseReplay: async (runId: string) => {
    const accomplish = getAccomplish();
    const run = await accomplish.pauseReplay(runId);
    if (run) {
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
        error: null,
      }));
    }
    return run;
  },

  resumeReplay: async (runId: string) => {
    const accomplish = getAccomplish();
    const run = await accomplish.resumeReplay(runId);
    if (run) {
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
        error: null,
      }));
    }
    return run;
  },

  stepReplay: async (runId: string) => {
    const accomplish = getAccomplish();
    const run = await accomplish.stepReplay(runId);
    if (run) {
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
        error: null,
      }));
    }
    return run;
  },

  cancelReplay: async (runId: string) => {
    const accomplish = getAccomplish();
    const run = await accomplish.cancelReplay(runId);
    if (run) {
      set((state) => ({
        replayRuns: { ...state.replayRuns, [run.id]: run },
        error: null,
      }));
    }
    return run;
  },

  applyReplayRun: (run: ReplayRun) => {
    set((state) => ({
      replayRuns: { ...state.replayRuns, [run.id]: run },
    }));
  },

  deleteRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    if (!accomplish.deleteRecording) {
      return;
    }
    await accomplish.deleteRecording(recordingId);
    set((state) => ({
      recordings: state.recordings.filter((recording) => recording.id !== recordingId),
      selectedRecording:
        state.selectedRecording?.id === recordingId ? null : state.selectedRecording,
    }));
  },

  exportRecording: async (recordingId: string) => {
    const accomplish = getAccomplish();
    if (!accomplish.exportRecording) {
      return null;
    }
    return accomplish.exportRecording(recordingId);
  },

  importRecording: async () => {
    const accomplish = getAccomplish();
    if (!accomplish.importRecording) {
      return null;
    }
    const recording = await accomplish.importRecording();
    if (recording) {
      set((state) => ({
        recordings: upsertRecording(state.recordings, recording),
        error: null,
      }));
    }
    return recording;
  },
}));
