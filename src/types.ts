export type CacheGetter<T = unknown> = (key: string) => Promise<T | null>;
export type CacheSetter<T = unknown> = (key: string, value: T) => Promise<void>;
export type CacheDeleter = (key: string) => Promise<void>;
export type CacheKeyLister = (prefix: string) => Promise<string[]>;

export type RequestBody = URLSearchParams | FormData | Record<string, unknown> | Blob | File | ArrayBuffer;

export type RequestConfig = {
  url: string;
  method: 'POST';
  headers?: Record<string, string>;
  body: RequestBody;
  signal?: AbortSignal;
  timeout?: number;
};

export type ApiResponse<T> = {
  status: number;
  message: string;
  traceId?: string;
  result: T;
  httpStatus?: number;
};

export type RequestAdapter = <T>(config: RequestConfig) => Promise<ApiResponse<T>>;

export type HashAdapter = (
  input: Blob,
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
  },
) => Promise<string>;

export type UploadPhase =
  | 'hashing'
  | 'init'
  | 'uploading'
  | 'merging'
  | 'success'
  | 'error'
  | 'paused'
  | 'canceled';

export type UploadTaskState =
  | 'idle'
  | 'hashing'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'merging'
  | 'success'
  | 'failed'
  | 'canceled';

export type ProgressInfo = {
  phase: UploadPhase;
  progress: number;
  uploadedSize: number;
  totalSize: number;
  speed: number;
  estimatedTime: number;
  chunks: number;
  uploadedChunks: number;
  currentChunk?: number;
  docId?: string;
};

export type UploadCache = {
  docId: string;
  docVersion?: string;
  fileHash: string;
  fileName: string;
  fileSize: number;
  chunks: number;
  chunkSize: number;
  uploadedChunks: number[];
  createdAt: number;
  updatedAt: number;
  status: UploadTaskState;
};

export type InitResult = {
  docId: string;
  chunks?: number[];
  docVersion?: string;
};

export type UploadResult = {
  docId: string;
  docVersion?: string;
  fileHash: string;
};

export type RetryClass = 'retryable' | 'fatal';

export type LargeFileUploaderOptions = {
  projectId: string;
  request: RequestAdapter;
  getPrivateDb: CacheGetter<UploadCache>;
  savePrivateDb: CacheSetter<UploadCache>;
  deletePrivateDb: CacheDeleter;
  listPrivateDbKeys?: CacheKeyLister;
  userId?: string;
  hash?: HashAdapter;
  concurrency?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  initTimeout?: number;
  uploadTimeout?: number;
  mergeTimeout?: number;
  initMaxRetries?: number;
  maxRetries?: number;
  mergeMaxRetries?: number;
  cacheExpireDays?: number;
};

export type UploadOptions = {
  fileName?: string;
  whiteList?: string;
  chunkSize?: number;
  concurrency?: number;
  maxRetries?: number;
  mergeMaxRetries?: number;
  onProgress?: (progress: ProgressInfo) => void;
};

export type CancelOptions = {
  clearCache?: boolean;
};

export type UploadTaskSnapshot = {
  state: UploadTaskState;
  progress: ProgressInfo | null;
  error: unknown;
};

export type UploadTask = {
  readonly promise: Promise<UploadResult>;
  pause(): void;
  resume(): void;
  cancel(options?: CancelOptions): void;
  getState(): UploadTaskSnapshot;
  subscribe(listener: (snapshot: UploadTaskSnapshot) => void): () => void;
};
