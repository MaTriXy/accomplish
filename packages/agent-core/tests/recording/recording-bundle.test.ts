import { describe, expect, it } from 'vitest';
import type { Recording } from '../../src/common/types/recording.js';
import {
  createRecordingBundle,
  parseRecordingBundle,
} from '../../src/recording/recording-bundle.js';

function createTestRecording(): Recording {
  return {
    id: 'rec-123',
    schemaVersion: 1,
    name: 'Checkout Flow',
    status: 'completed',
    metadata: {
      source: 'user',
      durationMs: 1200,
      stepCount: 2,
      startUrl: 'https://example.com',
      viewport: { width: 1280, height: 720 },
      userAgent: 'Accomplish Recording',
      appVersion: '1.0.0',
      platform: 'darwin',
    },
    steps: [
      {
        index: 0,
        id: 'step-1',
        timestampMs: 0,
        action: {
          type: 'navigate',
          url: 'https://example.com',
          navigationType: 'goto',
        },
        pageUrl: 'https://example.com',
        origin: 'user',
        screenshot: Buffer.from('fake-jpeg-data').toString('base64'),
      },
      {
        index: 1,
        id: 'step-2',
        timestampMs: 1200,
        action: {
          type: 'click',
          button: 'left',
          clickCount: 1,
        },
        pageUrl: 'https://example.com/checkout',
        origin: 'user',
      },
    ],
    privacyManifest: {
      configSnapshot: {
        enabled: true,
        recordAgentReasoning: true,
        redactEmails: true,
        redactSecrets: true,
        redactUrlQueryParams: true,
        redactAllFormInputs: false,
        captureScreenshots: true,
        blurAllScreenshots: false,
        maxScreenshotWidth: 960,
        maxScreenshotHeight: 540,
        customSensitiveKeys: ['token'],
      },
      redactions: [],
    },
    parameters: [],
    tags: ['qa'],
    createdAt: '2026-03-25T10:00:00.000Z',
    updatedAt: '2026-03-25T10:00:01.200Z',
  };
}

function corruptBundleEntry(bundle: Buffer, entryPath: string): Buffer {
  const pathBuffer = Buffer.from(entryPath, 'utf8');
  const pathOffset = bundle.indexOf(pathBuffer);
  if (pathOffset === -1) {
    throw new Error(`Bundle entry not found: ${entryPath}`);
  }

  const localHeaderOffset = pathOffset - 30;
  const compressedDataOffset = pathOffset + pathBuffer.length;
  const corruptedBundle = Buffer.from(bundle);
  corruptedBundle[compressedDataOffset] = corruptedBundle[compressedDataOffset] ^ 0xff;

  if (
    corruptedBundle.readUInt32LE(localHeaderOffset) !== 0x04034b50 ||
    compressedDataOffset >= corruptedBundle.length
  ) {
    throw new Error(`Unable to corrupt ZIP entry data for ${entryPath}`);
  }

  return corruptedBundle;
}

describe('recording bundle round-trip', () => {
  it('restores screenshots and provenance when parsing a created bundle', () => {
    const source = createTestRecording();

    const bundle = createRecordingBundle(source);
    const parsed = parseRecordingBundle(bundle);

    expect(parsed.recording.metadata.originalRecordingId).toBe(source.id);
    expect(parsed.recording.steps[0]?.screenshot).toBe(source.steps[0]?.screenshot);
    expect(parsed.recording.steps[1]?.screenshot).toBeUndefined();
    expect(parsed.manifest.originalRecordingId).toBe(source.id);
    expect(parsed.manifest.files.map((file) => file.path)).toContain('recording.json');
    expect(parsed.manifest.screenshots[0]?.stepId).toBe('step-1');
  });

  it('rejects tampered bundles with checksum mismatches', () => {
    const source = createTestRecording();
    const bundle = createRecordingBundle(source);
    const tamperedBundle = corruptBundleEntry(bundle, 'recording.json');

    expect(() => parseRecordingBundle(tamperedBundle)).toThrow(
      /Invalid ZIP bundle|checksum mismatch/,
    );
  });
});
