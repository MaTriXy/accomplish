import { RecordingManager as RecordingManagerImpl } from './recording-manager.js';

export type RecordingManager = RecordingManagerImpl;

export function createRecordingManager(): RecordingManagerImpl {
  return new RecordingManagerImpl();
}

export type {
  Recording,
  RecordingAction,
  ReplayErrorStrategy,
  ReplayOptions,
  ReplayRun,
  ReplayStatus,
  ReplayStepState,
  RecordingMetadata,
  RecordingOrigin,
  RecordingParameter,
  RecordingUpdateInput,
  RecordingSource,
  RecordingStatus,
  RecordingStep,
  SelectorStrategy,
  PrivacyAnnotation,
  PrivacyConfig,
  PrivacyManifest,
  WaitCondition,
  ElementSnapshot,
} from '../common/types/recording.js';

export { DEFAULT_PRIVACY_CONFIG, RECORDING_SCHEMA_VERSION } from '../common/types/recording.js';
