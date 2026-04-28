import { CancelError, PauseError, UploadSdkError } from './errors';
import { defaultHashAdapter } from './sha256';
import type {
  ApiResponse,
  InitResult,
  LargeFileUploaderOptions,
  ProgressInfo,
  RequestConfig,
  UploadCache,
  UploadOptions,
  UploadResult,
  UploadTask,
  UploadTaskSnapshot,
  UploadTaskState,
} from './types';
import {
  buildCacheKey,
  buildDocumentUrl,
  CACHE_PREFIX,
  classifyResponse,
  DEFAULT_CACHE_EXPIRE_DAYS,
  DEFAULT_RETRIES,
  delay,
  ensureSuccess,
  getFileLastModified,
  getSafeFileName,
  isRetryableError,
  normalizeChunkSize,
  normalizeConcurrency,
  validateWhiteList,
} from './utils';

export function createLargeFileUploader(options: LargeFileUploaderOptions): LargeFileUploader {
  return new LargeFileUploader(options);
}

export class LargeFileUploader {
  private readonly options: Required<
    Pick<
      LargeFileUploaderOptions,
      | 'concurrency'
      | 'minConcurrency'
      | 'maxConcurrency'
      | 'initTimeout'
      | 'uploadTimeout'
      | 'mergeTimeout'
      | 'initMaxRetries'
      | 'maxRetries'
      | 'mergeMaxRetries'
      | 'cacheExpireDays'
    >
  > &
    LargeFileUploaderOptions;

  constructor(options: LargeFileUploaderOptions) {
    this.options = {
      concurrency: options.concurrency ?? 3,
      minConcurrency: options.minConcurrency ?? 1,
      maxConcurrency: options.maxConcurrency ?? 4,
      initTimeout: options.initTimeout ?? 30_000,
      uploadTimeout: options.uploadTimeout ?? 120_000,
      mergeTimeout: options.mergeTimeout ?? 120_000,
      initMaxRetries: options.initMaxRetries ?? 1,
      maxRetries: options.maxRetries ?? DEFAULT_RETRIES,
      mergeMaxRetries: options.mergeMaxRetries ?? 1,
      cacheExpireDays: options.cacheExpireDays ?? DEFAULT_CACHE_EXPIRE_DAYS,
      ...options,
    };
    void this.cleanupExpiredCaches();
  }

  upload(file: Blob, uploadOptions: UploadOptions = {}): UploadTask {
    return new UploadTaskImpl(this.options, file, uploadOptions);
  }

  private async cleanupExpiredCaches(): Promise<void> {
    if (!this.options.listPrivateDbKeys) {
      return;
    }
    const prefix = `${CACHE_PREFIX}:${encodeURIComponent(this.options.projectId).replace(/%/g, '~')}:`;
    const expiresBefore = Date.now() - this.options.cacheExpireDays * 24 * 60 * 60 * 1000;
    const keys = await this.options.listPrivateDbKeys(prefix);
    await Promise.all(
      keys.map(async (key) => {
        const cache = await this.options.getPrivateDb(key);
        if (cache && cache.updatedAt < expiresBefore) {
          await this.options.deletePrivateDb(key);
        }
      }),
    );
  }
}

class UploadTaskImpl implements UploadTask {
  readonly promise: Promise<UploadResult>;

  private state: UploadTaskState = 'idle';
  private progress: ProgressInfo | null = null;
  private error: unknown = null;
  private readonly listeners = new Set<(snapshot: UploadTaskSnapshot) => void>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly runController = new AbortController();
  private readonly fileName: string;
  private readonly chunkSize: number;
  private readonly chunks: number;
  private readonly cacheKey: string;
  private readonly concurrency: number;
  private readonly startedAt = Date.now();
  private resolve!: (value: UploadResult) => void;
  private reject!: (reason?: unknown) => void;
  private cache: UploadCache | null = null;
  private fileHash = '';
  private docId = '';
  private paused = false;
  private canceled = false;
  private uploadedSize = 0;
  private activeUploads = 0;
  private nextChunk = 1;
  private pendingResume: (() => void) | null = null;

  constructor(
    private readonly options: LargeFileUploaderOptions & {
      concurrency: number;
      minConcurrency: number;
      maxConcurrency: number;
      initTimeout: number;
      uploadTimeout: number;
      mergeTimeout: number;
      initMaxRetries: number;
      maxRetries: number;
      mergeMaxRetries: number;
      cacheExpireDays: number;
    },
    private readonly file: Blob,
    private readonly uploadOptions: UploadOptions,
  ) {
    this.fileName = getSafeFileName(file, uploadOptions.fileName);
    this.chunkSize = normalizeChunkSize(uploadOptions.chunkSize);
    this.chunks = Math.ceil(file.size / this.chunkSize);
    const cacheKeyInput: {
      projectId: string;
      userId?: string;
      fileName: string;
      fileSize: number;
      lastModified: number;
    } = {
      projectId: options.projectId,
      fileName: this.fileName,
      fileSize: file.size,
      lastModified: getFileLastModified(file),
    };
    if (options.userId) {
      cacheKeyInput.userId = options.userId;
    }
    this.cacheKey = buildCacheKey(cacheKeyInput);
    this.concurrency = normalizeConcurrency(uploadOptions.concurrency ?? options.concurrency, options.minConcurrency, options.maxConcurrency);
    this.promise = new Promise<UploadResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    Promise.resolve().then(() => {
      void this.run();
    });
  }

  pause(): void {
    if (this.isTerminal()) {
      return;
    }
    this.paused = true;
    this.setState('paused');
    this.abortActiveRequests();
    this.pendingResume = null;
  }

  resume(): void {
    if (this.isTerminal() || !this.paused) {
      return;
    }
    this.paused = false;
    const resume = this.pendingResume;
    this.pendingResume = null;
    resume?.();
  }

  cancel(options: { clearCache?: boolean } = {}): void {
    if (this.isTerminal()) {
      return;
    }
    this.canceled = true;
    this.paused = false;
    this.runController.abort();
    this.abortActiveRequests();
    const clearCache = options.clearCache ?? true;
    void (clearCache ? this.options.deletePrivateDb(this.cacheKey) : Promise.resolve()).finally(() => {
      const error = new CancelError();
      this.error = error;
      this.setState('canceled');
      this.reject(error);
    });
  }

  getState(): UploadTaskSnapshot {
    return {
      state: this.state,
      progress: this.progress,
      error: this.error,
    };
  }

  subscribe(listener: (snapshot: UploadTaskSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async run(): Promise<void> {
    try {
      this.validateInput();
      validateWhiteList(this.fileName, this.file, this.uploadOptions.whiteList);
      await this.loadCache();
      await this.computeHash();
      await this.ensureUploadTask();
      await this.uploadMissingChunks();
      await this.merge();
      const docVersion = this.cache?.docVersion;
      await this.options.deletePrivateDb(this.cacheKey);
      this.cache = null;
      this.emitProgress('success', 100);
      this.setState('success');
      const result: UploadResult = { docId: this.docId, fileHash: this.fileHash };
      if (docVersion) {
        result.docVersion = docVersion;
      }
      this.resolve(result);
    } catch (error) {
      if (this.canceled) {
        return;
      }
      if (this.paused || error instanceof PauseError) {
        await this.waitUntilResumed();
        return this.run();
      }
      this.error = error;
      this.setState('failed');
      this.emitProgress('error', this.progress?.progress ?? 0);
      this.reject(error);
    }
  }

  private validateInput(): void {
    if (this.file.size === 0) {
      throw new UploadSdkError('Zero-byte files are not supported', 'EMPTY_FILE');
    }
    if (this.chunks > 10_000) {
      throw new UploadSdkError('File produces more than 10000 chunks', 'TOO_MANY_CHUNKS');
    }
  }

  private async loadCache(): Promise<void> {
    this.cache = await this.options.getPrivateDb(this.cacheKey);
    if (this.cache) {
      this.docId = this.cache.docId;
      this.fileHash = this.cache.fileHash;
      this.uploadedSize = this.cache.uploadedChunks.reduce((total, chunk) => total + this.getChunkSize(chunk), 0);
    }
  }

  private async computeHash(): Promise<void> {
    this.throwIfCanceledOrPaused();
    this.setState('hashing');
    const hash = this.options.hash ?? defaultHashAdapter;
    const controller = this.trackController();
    try {
      this.fileHash = await hash(this.file, {
        signal: controller.signal,
        onProgress: (progress) => this.emitProgress('hashing', progress),
      });
    } finally {
      this.untrackController(controller);
    }
  }

  private async ensureUploadTask(): Promise<void> {
    this.throwIfCanceledOrPaused();
    if (this.cache?.docId) {
      this.docId = this.cache.docId;
      return;
    }
    this.setState('initializing');
    this.emitProgress('init', this.progress?.progress ?? 0);
    const body = new URLSearchParams();
    body.set('checkCode', this.fileHash);
    body.set('fileName', this.fileName);
    body.set('chunks', String(this.chunks));
    body.set('fileSize', String(this.file.size));
    if (this.uploadOptions.whiteList) {
      body.set('whiteList', this.uploadOptions.whiteList);
    }
    const result = await this.requestWithRetry<InitResult>(
      {
        url: buildDocumentUrl(this.options.projectId, 'init'),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        timeout: this.options.initTimeout,
      },
      this.options.initMaxRetries,
    );
    this.docId = result.docId;
    const cache: UploadCache = {
      docId: result.docId,
      fileHash: this.fileHash,
      fileName: this.fileName,
      fileSize: this.file.size,
      chunks: this.chunks,
      chunkSize: this.chunkSize,
      uploadedChunks: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'uploading',
    };
    if (result.docVersion) {
      cache.docVersion = result.docVersion;
    }
    this.cache = cache;
    await this.saveCache();
  }

  private async uploadMissingChunks(): Promise<void> {
    this.setState('uploading');
    const uploaded = new Set(this.cache?.uploadedChunks ?? []);
    this.nextChunk = 1;
    await new Promise<void>((resolve, reject) => {
      const schedule = () => {
        if (this.canceled) {
          reject(new CancelError());
          return;
        }
        if (this.paused) {
          reject(new PauseError());
          return;
        }
        while (this.activeUploads < this.concurrency && this.nextChunk <= this.chunks) {
          const chunk = this.nextChunk;
          this.nextChunk += 1;
          if (uploaded.has(chunk)) {
            continue;
          }
          this.activeUploads += 1;
          void this.uploadChunk(chunk)
            .then(async () => {
              uploaded.add(chunk);
              this.uploadedSize += this.getChunkSize(chunk);
              if (this.cache && !this.cache.uploadedChunks.includes(chunk)) {
                this.cache.uploadedChunks.push(chunk);
                this.cache.updatedAt = Date.now();
                this.cache.status = 'uploading';
                await this.saveCache();
              }
              this.emitProgress('uploading', (this.uploadedSize / this.file.size) * 100, chunk);
            })
            .then(() => {
              this.activeUploads -= 1;
              if (uploaded.size === this.chunks) {
                resolve();
              } else {
                schedule();
              }
            })
            .catch((error) => {
              this.activeUploads -= 1;
              reject(error);
            });
        }
        if (uploaded.size === this.chunks) {
          resolve();
        }
      };
      schedule();
    });
  }

  private async uploadChunk(chunk: number): Promise<void> {
    this.throwIfCanceledOrPaused();
    const start = (chunk - 1) * this.chunkSize;
    const end = Math.min(start + this.chunkSize, this.file.size);
    const blob = this.file.slice(start, end);
    const hash = this.options.hash ?? defaultHashAdapter;
    const hashController = this.trackController();
    let checkCode: string;
    try {
      checkCode = await hash(blob, { signal: hashController.signal });
    } finally {
      this.untrackController(hashController);
    }

    const form = new FormData();
    form.set('docId', this.docId);
    form.set('checkCode', checkCode);
    form.set('isCheckCode', 'Y');
    form.set('fileName', this.fileName);
    form.set('chunk', String(chunk));
    form.set('multipartFile', blob, this.fileName);

    await this.requestWithRetry<null>(
      {
        url: buildDocumentUrl(this.options.projectId, 'upload'),
        method: 'POST',
        body: form,
        timeout: this.options.uploadTimeout,
      },
      this.uploadOptions.maxRetries ?? this.options.maxRetries,
    );
  }

  private async merge(): Promise<void> {
    this.throwIfCanceledOrPaused();
    this.setState('merging');
    this.emitProgress('merging', 100);
    await this.requestWithRetry<null>(
      {
        url: buildDocumentUrl(this.options.projectId, 'merge'),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { docId: this.docId, checkCode: this.fileHash },
        timeout: this.options.mergeTimeout,
      },
      this.uploadOptions.mergeMaxRetries ?? this.options.mergeMaxRetries,
    );
  }

  private async requestWithRetry<T>(config: Omit<RequestConfig, 'signal'>, maxRetries: number): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= maxRetries) {
      this.throwIfCanceledOrPaused();
      const controller = this.trackController();
      try {
        const response = await this.options.request<T>({ ...config, signal: controller.signal });
        if (response.status !== 200 && classifyResponse(response) === 'fatal') {
          return ensureSuccess(response);
        }
        return ensureSuccess(response);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt >= maxRetries) {
          throw error;
        }
        await delay(Math.min(30_000, 500 * 2 ** attempt), this.runController.signal);
      } finally {
        this.untrackController(controller);
      }
      attempt += 1;
    }
    throw lastError;
  }

  private async saveCache(): Promise<void> {
    if (!this.cache) {
      return;
    }
    await this.options.savePrivateDb(this.cacheKey, this.cache);
  }

  private emitProgress(phase: ProgressInfo['phase'], progress: number, currentChunk?: number): void {
    const elapsed = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const uploadedSize = phase === 'success' || phase === 'merging' ? this.file.size : Math.min(this.uploadedSize, this.file.size);
    const speed = uploadedSize / elapsed;
    const remaining = Math.max(0, this.file.size - uploadedSize);
    const nextProgress: ProgressInfo = {
      phase,
      progress: Math.max(0, Math.min(100, progress)),
      uploadedSize,
      totalSize: this.file.size,
      speed,
      estimatedTime: speed > 0 ? remaining / speed : Number.POSITIVE_INFINITY,
      chunks: this.chunks,
      uploadedChunks: this.cache?.uploadedChunks.length ?? 0,
    };
    if (typeof currentChunk === 'number') {
      nextProgress.currentChunk = currentChunk;
    }
    if (this.docId) {
      nextProgress.docId = this.docId;
    }
    this.progress = nextProgress;
    this.uploadOptions.onProgress?.(this.progress);
    this.emit();
  }

  private setState(state: UploadTaskState): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private trackController(): AbortController {
    const controller = new AbortController();
    this.activeControllers.add(controller);
    this.runController.signal.addEventListener('abort', () => controller.abort(), { once: true });
    return controller;
  }

  private untrackController(controller: AbortController): void {
    this.activeControllers.delete(controller);
  }

  private abortActiveRequests(): void {
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }

  private throwIfCanceledOrPaused(): void {
    if (this.canceled || this.runController.signal.aborted) {
      throw new CancelError();
    }
    if (this.paused) {
      throw new PauseError();
    }
  }

  private waitUntilResumed(): Promise<void> {
    if (!this.paused) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pendingResume = resolve;
    });
  }

  private getChunkSize(chunk: number): number {
    const start = (chunk - 1) * this.chunkSize;
    return Math.max(0, Math.min(this.chunkSize, this.file.size - start));
  }

  private isTerminal(): boolean {
    return this.state === 'success' || this.state === 'failed' || this.state === 'canceled';
  }
}
