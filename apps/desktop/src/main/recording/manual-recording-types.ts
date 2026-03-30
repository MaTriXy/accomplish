import type {
  ElementSnapshot,
  PrivacyAnnotation,
  Recording,
  RecordingAction,
  SelectorStrategy,
} from '@accomplish_ai/agent-core/common';
import { CdpClient } from './cdp-client';

export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
export const MANUAL_RECORDER_POLL_MS = 250;
export const SCREENSHOT_QUALITY = 55;

export interface ManualRawEvent {
  kind: 'click' | 'fill' | 'select' | 'keypress' | 'scroll' | 'upload';
  timestamp: number;
  pageUrl: string;
  selectors?: SelectorStrategy[];
  button?: number;
  clickCount?: number;
  x?: number;
  y?: number;
  value?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
}

export interface ManualDrainPayload {
  events: ManualRawEvent[];
  url: string;
}

export interface ManualRecordingSession {
  recordingId: string;
  pageName: string;
  targetId: string;
  cdp: CdpClient;
  cdpSessionId: string;
  pollTimer: ReturnType<typeof setInterval>;
  lastPageUrl: string;
}

export interface ManualScreenshotMaskResult {
  maskedRegionCount: number;
  targetSnapshot: ElementSnapshot | null;
  viewport: { width: number; height: number };
}

export interface ManualStepArtifacts {
  screenshot?: string;
  targetSnapshot?: ElementSnapshot;
  privacyAnnotations?: PrivacyAnnotation[];
}

export interface ManualStepInput {
  action: RecordingAction;
  selectors?: SelectorStrategy[];
  pageUrl: string;
}

export type ManualRecording = Recording;
