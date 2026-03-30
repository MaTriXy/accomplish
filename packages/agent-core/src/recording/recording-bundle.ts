import crypto from 'crypto';
import zlib from 'zlib';
import type { Recording } from '../common/types/recording.js';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const MAX_ZIP_ENTRY_UNCOMPRESSED_SIZE = 25 * 1024 * 1024;

interface BundleEntry {
  path: string;
  data: Buffer;
  compression: 0 | 8;
  crc32: number;
  compressedData: Buffer;
  sha256: string;
}

interface ZipEntryRecord {
  path: string;
  data: Buffer;
}

export interface RecordingBundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface RecordingBundleScreenshot {
  stepId: string;
  path: string;
  sha256: string;
  size: number;
}

export interface RecordingBundleManifest {
  bundleVersion: number;
  bundleId: string;
  exportedAt: string;
  recordingSchemaVersion: number;
  originalRecordingId: string;
  files: RecordingBundleFile[];
  screenshots: RecordingBundleScreenshot[];
}

export interface ParsedRecordingBundle {
  manifest: RecordingBundleManifest;
  recording: Recording;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toDosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(value.getUTCFullYear(), 1980);
  const month = value.getUTCMonth() + 1;
  const day = value.getUTCDate();
  const hours = value.getUTCHours();
  const minutes = value.getUTCMinutes();
  const seconds = Math.floor(value.getUTCSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function readUInt16LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function buildZip(entries: ZipEntryRecord[]): Buffer {
  const preparedEntries: BundleEntry[] = entries.map((entry) => {
    const compressedData = zlib.deflateRawSync(entry.data, { level: 9 });
    return {
      path: entry.path,
      data: entry.data,
      compression: 8,
      crc32: crc32(entry.data),
      compressedData,
      sha256: sha256(entry.data),
    };
  });

  const localHeaders: Buffer[] = [];
  const centralDirectoryHeaders: Buffer[] = [];
  let currentOffset = 0;
  const now = toDosDateTime(new Date());

  for (const entry of preparedEntries) {
    const pathBuffer = Buffer.from(entry.path, 'utf8');
    const localHeader = Buffer.alloc(30 + pathBuffer.length);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(ZIP_VERSION, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(entry.compression, 8);
    localHeader.writeUInt16LE(now.time, 10);
    localHeader.writeUInt16LE(now.date, 12);
    localHeader.writeUInt32LE(entry.crc32, 14);
    localHeader.writeUInt32LE(entry.compressedData.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(pathBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuffer.copy(localHeader, 30);
    localHeaders.push(localHeader, entry.compressedData);

    const centralDirectoryHeader = Buffer.alloc(46 + pathBuffer.length);
    centralDirectoryHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralDirectoryHeader.writeUInt16LE(ZIP_VERSION, 4);
    centralDirectoryHeader.writeUInt16LE(ZIP_VERSION, 6);
    centralDirectoryHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralDirectoryHeader.writeUInt16LE(entry.compression, 10);
    centralDirectoryHeader.writeUInt16LE(now.time, 12);
    centralDirectoryHeader.writeUInt16LE(now.date, 14);
    centralDirectoryHeader.writeUInt32LE(entry.crc32, 16);
    centralDirectoryHeader.writeUInt32LE(entry.compressedData.length, 20);
    centralDirectoryHeader.writeUInt32LE(entry.data.length, 24);
    centralDirectoryHeader.writeUInt16LE(pathBuffer.length, 28);
    centralDirectoryHeader.writeUInt16LE(0, 30);
    centralDirectoryHeader.writeUInt16LE(0, 32);
    centralDirectoryHeader.writeUInt16LE(0, 34);
    centralDirectoryHeader.writeUInt16LE(0, 36);
    centralDirectoryHeader.writeUInt32LE(0, 38);
    centralDirectoryHeader.writeUInt32LE(currentOffset, 42);
    pathBuffer.copy(centralDirectoryHeader, 46);
    centralDirectoryHeaders.push(centralDirectoryHeader);

    currentOffset += localHeader.length + entry.compressedData.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryHeaders);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(preparedEntries.length, 8);
  endOfCentralDirectory.writeUInt16LE(preparedEntries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(currentOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDirectory, endOfCentralDirectory]);
}

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error('Invalid ZIP bundle: end of central directory not found');
}

function extractZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
  const totalEntries = readUInt16LE(buffer, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32LE(buffer, eocdOffset + 16);

  const entries = new Map<string, Buffer>();
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32LE(buffer, offset) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      throw new Error('Invalid ZIP bundle: central directory header missing');
    }

    const flags = readUInt16LE(buffer, offset + 8);
    const compressionMethod = readUInt16LE(buffer, offset + 10);
    const expectedCrc32 = readUInt32LE(buffer, offset + 16);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const fileNameLength = readUInt16LE(buffer, offset + 28);
    const extraFieldLength = readUInt16LE(buffer, offset + 30);
    const fileCommentLength = readUInt16LE(buffer, offset + 32);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.toString(
      (flags & ZIP_UTF8_FLAG) !== 0 ? 'utf8' : 'binary',
      fileNameStart,
      fileNameEnd,
    );

    offset = fileNameEnd + extraFieldLength + fileCommentLength;

    if (fileName.endsWith('/')) {
      continue;
    }

    if (readUInt32LE(buffer, localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid ZIP bundle: local header missing for ${fileName}`);
    }

    const localFileNameLength = readUInt16LE(buffer, localHeaderOffset + 26);
    const localExtraFieldLength = readUInt16LE(buffer, localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

    let data: Buffer;
    if (compressionMethod === 0) {
      data = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      if (uncompressedSize < 0 || uncompressedSize > MAX_ZIP_ENTRY_UNCOMPRESSED_SIZE) {
        throw new Error(`Invalid ZIP bundle: declared size too large for ${fileName}`);
      }
      try {
        data = zlib.inflateRawSync(compressedData);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ZIP bundle: unable to inflate ${fileName} (${message})`);
      }
    } else {
      throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`Invalid ZIP bundle: size mismatch for ${fileName}`);
    }
    if (crc32(data) !== expectedCrc32) {
      throw new Error(`Invalid ZIP bundle: CRC mismatch for ${fileName}`);
    }

    entries.set(fileName, data);
  }

  return entries;
}

function buildBundleManifest(
  recording: Recording,
  bundleEntries: BundleEntry[],
  screenshots: RecordingBundleScreenshot[],
): RecordingBundleManifest {
  const originalRecordingId = recording.metadata.originalRecordingId ?? recording.id;
  return {
    bundleVersion: 1,
    bundleId: crypto.randomUUID(),
    exportedAt: new Date().toISOString(),
    recordingSchemaVersion: recording.schemaVersion,
    originalRecordingId,
    files: bundleEntries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      size: entry.data.length,
    })),
    screenshots,
  };
}

export function createRecordingBundle(recording: Recording): Buffer {
  const screenshotEntries: ZipEntryRecord[] = [];
  const screenshots: RecordingBundleScreenshot[] = [];

  const bundleRecording: Recording = {
    ...recording,
    metadata: {
      ...recording.metadata,
      originalRecordingId: recording.metadata.originalRecordingId ?? recording.id,
    },
    steps: recording.steps.map((step, index) => {
      if (!step.screenshot) {
        return step;
      }

      const screenshotPath = `screenshots/step-${String(index).padStart(4, '0')}-${step.id}.jpg`;
      const screenshotBuffer = Buffer.from(step.screenshot, 'base64');
      const screenshotHash = sha256(screenshotBuffer);

      screenshotEntries.push({
        path: screenshotPath,
        data: screenshotBuffer,
      });
      screenshots.push({
        stepId: step.id,
        path: screenshotPath,
        sha256: screenshotHash,
        size: screenshotBuffer.length,
      });

      return {
        ...step,
        screenshot: undefined,
      };
    }),
  };

  const recordingBuffer = Buffer.from(JSON.stringify(bundleRecording, null, 2), 'utf8');
  const preliminaryEntries = [
    { path: 'recording.json', data: recordingBuffer },
    ...screenshotEntries,
  ];
  const preparedPreliminaryEntries = preliminaryEntries.map((entry) => ({
    path: entry.path,
    data: entry.data,
    compression: 8 as const,
    crc32: crc32(entry.data),
    compressedData: zlib.deflateRawSync(entry.data, { level: 9 }),
    sha256: sha256(entry.data),
  }));

  const manifest = buildBundleManifest(bundleRecording, preparedPreliminaryEntries, screenshots);
  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  return buildZip([
    {
      path: 'manifest.json',
      data: manifestBuffer,
    },
    {
      path: 'recording.json',
      data: recordingBuffer,
    },
    ...screenshotEntries,
  ]);
}

export function parseRecordingBundle(buffer: Buffer): ParsedRecordingBundle {
  const entries = extractZipEntries(buffer);
  const manifestBuffer = entries.get('manifest.json');
  const recordingBuffer = entries.get('recording.json');

  if (!recordingBuffer) {
    throw new Error('Invalid recording bundle: recording.json is missing');
  }

  const recording = JSON.parse(recordingBuffer.toString('utf8')) as Recording;
  const manifest = manifestBuffer
    ? (JSON.parse(manifestBuffer.toString('utf8')) as RecordingBundleManifest)
    : {
        bundleVersion: 1,
        bundleId: crypto.randomUUID(),
        exportedAt: new Date().toISOString(),
        recordingSchemaVersion: recording.schemaVersion,
        originalRecordingId: recording.metadata.originalRecordingId ?? recording.id,
        files: [],
        screenshots: [],
      };

  for (const file of manifest.files ?? []) {
    const entryBuffer = entries.get(file.path);
    if (!entryBuffer) {
      throw new Error(`Invalid recording bundle: missing file ${file.path}`);
    }
    if (sha256(entryBuffer) !== file.sha256) {
      throw new Error(`Invalid recording bundle: checksum mismatch for ${file.path}`);
    }
  }

  const screenshotsByStepId = new Map(
    (manifest.screenshots ?? []).map((item) => [item.stepId, item]),
  );
  recording.steps = recording.steps.map((step) => {
    const screenshotEntry = screenshotsByStepId.get(step.id);
    if (!screenshotEntry) {
      return step;
    }

    const screenshotBuffer = entries.get(screenshotEntry.path);
    if (!screenshotBuffer) {
      return step;
    }

    return {
      ...step,
      screenshot: screenshotBuffer.toString('base64'),
    };
  });

  return { manifest, recording };
}
