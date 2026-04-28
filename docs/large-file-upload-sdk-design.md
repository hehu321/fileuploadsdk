# 前端大文件上传 SDK 技术设计文档

## 1. 背景与目标

本文档描述一个面向 React 使用场景的前端大文件上传 SDK 技术方案。SDK 以 TypeScript 源码模块形式交付，负责文件分片、SHA-256 校验、断点续传、并发上传、进度回调、失败重试、暂停/恢复/取消等能力。

服务端提供三个接口：

- 初始化接口：`POST /projects/{project_id}/chunk/documents?type=init`
- 分片上传接口：`POST /projects/{project_id}/chunk/documents?type=upload`
- 分片合并接口：`POST /projects/{project_id}/chunk/documents?type=merge`

SDK 不内置请求库，不使用 IndexedDB。请求能力和缓存能力均由调用方注入。核心能力保持纯 TypeScript 实现，同时额外提供一个可选的 React Hook 薄封装，便于 React 项目管理上传状态和生命周期。

## 2. SDK 能力范围

- 支持大文件分片上传。
- 支持刷新后的断点续传。
- 支持调用方配置并发分片数量。
- 支持分片级上传进度回调。
- 支持上传前计算整文件 SHA-256。
- 支持每个分片单独计算 SHA-256。
- 支持 Web Worker 或调用方注入的异步 hash 方法，避免大文件 hash 阻塞主线程。
- 支持分片失败自动重试。
- 支持暂停、恢复、取消上传任务。
- 支持使用调用方注入的私有缓存方法保存上传状态。
- 支持可选的 `useLargeFileUpload` React Hook。

## 3. 接口约定

### 3.1 调用方注入能力

```ts
type CacheGetter<T = unknown> = (key: string) => Promise<T | null>;
type CacheSetter<T = unknown> = (key: string, value: T) => Promise<void>;
type CacheDeleter = (key: string) => Promise<void>;

type RequestBody = URLSearchParams | FormData | Record<string, unknown> | Blob | File | ArrayBuffer;

type RequestConfig = {
  url: string;
  method: 'POST';
  headers?: Record<string, string>;
  body: RequestBody;
  signal?: AbortSignal;
  timeout?: number;
};

type RequestAdapter = <T>(config: RequestConfig) => Promise<{
  status: number;
  message: string;
  traceId?: string;
  result: T;
}>;

type HashAdapter = (input: Blob, options?: {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}) => Promise<string>;

type ProgressInfo = {
  phase: 'hashing' | 'init' | 'uploading' | 'merging' | 'success' | 'error' | 'paused' | 'canceled';
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
```

### 3.2 SDK 主要入口

```ts
const uploader = createLargeFileUploader({
  projectId,
  request,
  getPrivateDb,
  savePrivateDb,
  deletePrivateDb,
  hash,
  concurrency,
  initTimeout,
  mergeTimeout,
});

const task = uploader.upload(file, {
  fileName,
  whiteList,
  chunkSize,
  maxRetries,
  mergeMaxRetries,
  onProgress,
});

task.pause();
task.resume();
task.cancel();
await task.promise;
```

### 3.3 React Hook 封装

SDK 核心不依赖 React，React 场景额外提供 `useLargeFileUpload`。Hook 只负责状态管理和组件生命周期绑定，不改变核心上传行为。

```ts
const {
  upload,
  pause,
  resume,
  cancel,
  state,
  progress,
  error,
} = useLargeFileUpload({
  projectId,
  request,
  getPrivateDb,
  savePrivateDb,
  deletePrivateDb,
  concurrency,
});
```

## 4. 实现过程流程图

下图展示从用户选择文件到上传完成的完整 SDK 实现流程，包括参数校验、整文件 hash、缓存恢复、初始化、并发分片上传、缓存更新、合并以及异常保留缓存。

![实现过程流程图](./assets/upload-flow.png)

## 5. 架构设计图

下图展示调用方、SDK 内部模块、缓存适配器、请求适配器和服务端接口之间的边界关系。SDK 专注上传任务编排，鉴权、请求实现和缓存持久化由调用方负责。

![架构设计图](./assets/upload-architecture.png)

## 6. 上传时序图

下图展示用户、React 应用、SDK、缓存适配器、请求适配器与三个服务端接口之间的调用顺序。

![上传时序图](./assets/upload-sequence.png)

## 7. 关键设计说明

### 7.1 分片规则

- 默认分片大小为 `5MB`。
- 分片大小不超过 `10MB`。
- 分片序号从 `1` 开始。
- 分片数量范围为 `2-10000`。

### 7.2 SHA-256 校验

- 初始化和合并接口使用整文件 SHA-256。
- 分片上传接口使用当前分片 SHA-256。
- Hash 阶段纳入进度回调，便于 UI 展示完整上传生命周期。
- GB 级文件禁止在主线程同步计算 hash。SDK 默认使用 Web Worker 执行 SHA-256 计算，避免阻塞 React UI。
- SDK 支持调用方注入 `hash` 方法，用于接入业务侧已有的 Worker、WASM 或后端预计算能力。
- 恢复上传时允许先用非 hash 缓存 key 找到任务，再异步校验整文件 hash，避免每次刷新都必须先完整 hash 才能恢复。

### 7.3 请求适配

SDK 不直接依赖 `fetch`、`axios` 或其他请求库。调用方通过 `request` adapter 统一处理：

- `baseURL`
- cookie 鉴权
- headers
- 网关错误处理
- `AbortSignal`
- 超时控制

### 7.4 超时与重试分层

不同接口的耗时特征不同，不能使用同一套重试策略：

- `init`：请求体较小，建议提供独立的 `initTimeout` 和 `initMaxRetries`。
- `upload`：以分片为单位重试，失败后只重传当前分片。
- `merge`：服务端可能需要合并大量分片，建议提供独立的 `mergeTimeout` 和 `mergeMaxRetries`。

如果服务端合并耗时较长，推荐将 `merge` 改造成异步任务接口：前端提交合并任务后轮询合并状态，避免网关超时导致前端无法判断最终结果。

## 8. 缓存与断点续传策略

SDK 使用调用方传入的三个异步缓存方法：

- `getPrivateDb(key)`
- `savePrivateDb(key, value)`
- `deletePrivateDb(key)`

缓存 key 不包含 `fileHash`。否则恢复上传前必须先完整计算文件 hash，导致刷新后无法快速恢复。

缓存 key 建议包含：

```text
large-upload:{projectId}:{userId}:{fileName}:{fileSize}:{lastModified}
```

缓存内容建议包含：

```ts
type UploadCache = {
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
};
```

恢复上传时，SDK 先通过非 hash 缓存 key 查询任务，信任本地缓存中的 `uploadedChunks`，跳过已成功分片，只上传未完成分片。整文件 hash 仍会在恢复流程中计算，用于后续 `merge` 校验和缓存内容一致性确认。合并成功后删除缓存。

缓存 adapter 使用对象类型交互，序列化和存储细节由调用方负责。这样 SDK 不强制调用方必须使用字符串存储，也避免 getter/setter 类型不一致。

## 9. 异常与重试策略

- 分片上传失败后自动重试。
- 默认最大重试次数建议为 `3`。
- 超过重试次数后任务失败，并保留缓存。
- `pause()` 停止调度新的分片，并通过 `AbortController.abort()` 取消正在上传的分片请求。被取消的分片标记为未完成，恢复时重新上传。
- `resume()` 继续调度剩余分片。
- `cancel()` 中止请求并停止任务，同时保留缓存，便于后续恢复。
- `merge` 失败时不删除缓存，按照独立的 merge 重试策略处理。超过重试次数后任务进入失败态，由业务 UI 提示用户重试或稍后恢复。

## 10. 测试建议

- 首次上传完整成功。
- 上传一部分后刷新页面，恢复时跳过已上传分片。
- 分片失败后自动重试并最终成功。
- 分片超过最大重试次数后任务失败且缓存保留。
- `pause()` 后不再调度新分片，并取消正在上传的分片请求。
- `resume()` 后继续上传剩余分片。
- `cancel()` 后请求被中止且缓存保留。
- `merge` 成功后缓存被删除。
- `merge` 超时后按独立策略重试，最终失败时缓存保留。
- GB 级文件 hash 计算期间 React UI 不阻塞。
- 刷新恢复时无需先完成整文件 hash 才能命中缓存。
