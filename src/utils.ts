import { FatalRequestError, UploadSdkError } from './errors';
import type { ApiResponse, RetryClass } from './types';

export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
export const MAX_CHUNK_SIZE = 10 * 1024 * 1024;
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MIN_CONCURRENCY = 1;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_CACHE_EXPIRE_DAYS = 7;
export const CACHE_PREFIX = 'large-upload';

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const FATAL_STATUS = new Set([400, 401, 403, 404, 409, 413, 415]);

export function buildDocumentUrl(projectId: string, type: 'init' | 'upload' | 'merge'): string {
  return `/projects/${encodeURIComponent(projectId)}/chunk/documents?type=${type}`;
}

export function normalizeConcurrency(value: number | undefined, min = DEFAULT_MIN_CONCURRENCY, max = DEFAULT_MAX_CONCURRENCY): number {
  if (value === undefined) {
    return DEFAULT_CONCURRENCY;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new UploadSdkError('concurrency must be a positive integer', 'INVALID_CONCURRENCY');
  }
  return Math.max(min, Math.min(max, value));
}

export function normalizeChunkSize(value: number | undefined): number {
  const chunkSize = value ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new UploadSdkError('chunkSize must be a positive integer', 'INVALID_CHUNK_SIZE');
  }
  if (chunkSize > MAX_CHUNK_SIZE) {
    throw new UploadSdkError('chunkSize must not exceed 10MB', 'INVALID_CHUNK_SIZE');
  }
  return chunkSize;
}

export function buildCacheKey(input: {
  projectId: string;
  userId?: string;
  fileName: string;
  fileSize: number;
  lastModified?: number;
}): string {
  const userId = input.userId || 'anonymous';
  const lastModified = input.lastModified ?? 0;
  return [
    CACHE_PREFIX,
    encodePart(input.projectId),
    encodePart(userId),
    encodePart(input.fileName),
    String(input.fileSize),
    String(lastModified),
  ].join(':');
}

export function classifyResponse<T>(response: ApiResponse<T>): RetryClass {
  const status = response.httpStatus ?? response.status;
  if (RETRYABLE_STATUS.has(status)) {
    return 'retryable';
  }
  if (FATAL_STATUS.has(status) || (status >= 400 && status < 500)) {
    return 'fatal';
  }
  if (response.status !== 200) {
    return status >= 500 ? 'retryable' : 'fatal';
  }
  return 'retryable';
}

export function ensureSuccess<T>(response: ApiResponse<T>): T {
  if (response.status === 200) {
    return response.result;
  }
  const kind = classifyResponse(response);
  if (kind === 'fatal') {
    throw new FatalRequestError(response.message || 'Fatal upload request error', response.httpStatus ?? response.status, response);
  }
  throw new UploadSdkError(response.message || 'Retryable upload request error', 'RETRYABLE_REQUEST', response);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof FatalRequestError) {
    return false;
  }
  if (error instanceof UploadSdkError && error.code === 'RETRYABLE_REQUEST') {
    return true;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  return true;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function getFileLastModified(file: Blob): number {
  const maybeFile = file as File;
  return typeof maybeFile.lastModified === 'number' ? maybeFile.lastModified : 0;
}

export function getSafeFileName(file: Blob, fileName?: string): string {
  if (fileName) {
    return fileName;
  }
  const maybeFile = file as File;
  return typeof maybeFile.name === 'string' && maybeFile.name ? maybeFile.name : 'unnamed';
}

export function parseWhiteList(whiteList?: string): string[] {
  if (!whiteList) {
    return [];
  }
  return whiteList
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function validateWhiteList(fileName: string, file: Blob, whiteList?: string): void {
  const rules = parseWhiteList(whiteList);
  if (rules.length === 0) {
    return;
  }
  const lowerName = fileName.toLowerCase();
  const mime = file.type.toLowerCase();
  const allowed = rules.some((rule) => {
    if (rule.startsWith('.')) {
      return lowerName.endsWith(rule);
    }
    if (rule.includes('/')) {
      return mime === rule;
    }
    return lowerName.endsWith(`.${rule}`);
  });

  if (!allowed) {
    throw new UploadSdkError('File is not allowed by whiteList', 'WHITE_LIST_REJECTED');
  }
}

function encodePart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '~');
}
