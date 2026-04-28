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
- 不支持零字节文件；小文件是否进入分片流程由调用方或后端能力决定。

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
  httpStatus?: number;
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

type UploadTaskState =
  | 'idle'
  | 'hashing'
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'merging'
  | 'success'
  | 'failed'
  | 'canceled';

class CancelError extends Error {
  name: 'CancelError';
}
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
  minConcurrency,
  maxConcurrency,
  initTimeout,
  initMaxRetries,
  mergeTimeout,
  mergeMaxRetries,
  cacheExpireDays,
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
task.cancel({ clearCache: true });
await task.promise;
```

上传入口必须先做防御性校验：

- `file.size === 0` 时直接抛出业务错误，不进入 hash、init 或分片流程，避免进度计算出现 `NaN`。
- 当 `file.size <= chunkSize` 时，若服务端分片接口不支持单分片合并，调用方应走普通直传接口；若服务端支持单分片合并，SDK 可以按 `chunks = 1` 处理。
- `chunkSize` 超过 `10MB` 时直接拒绝，避免违背服务端分片约束。
- `concurrency` 必须是正整数，超出范围时按配置边界夹取或抛出配置错误。

`task.promise` 的生命周期规则必须稳定：

- `pause()`：任务进入 `paused`，中止正在上传的分片请求，`task.promise` 保持 pending。
- `resume()`：任务复用原来的 `task.promise`，继续上传未完成分片，不创建新的 Promise。
- `cancel()`：任务进入 `canceled`，中止请求并 reject `task.promise`，错误类型为 `CancelError`。
- 致命错误：任务进入 `failed`，reject `task.promise`，保留缓存供后续恢复。
- 成功完成：任务进入 `success`，resolve `task.promise`，删除缓存。

### 3.3 React Hook 封装

SDK 核心不依赖 React，React 场景额外提供 `useLargeFileUpload`。推荐采用全局单例上传管理器，Hook 只订阅全局任务状态并向组件暴露操作方法，不把上传任务绑定在单个页面组件的局部 state 上。

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

Hook 生命周期约定：

- 组件卸载时，Hook 必须取消自身订阅，禁止继续触发该组件的 `setState`。
- 默认不自动暂停上传任务，上传任务由全局单例继续运行，适合跨路由展示全局上传进度。
- 如果业务需要页面卸载即暂停，可在 Hook 选项中提供 `pauseOnUnmount: true`，由 cleanup 调用 `task.pause()`。
- 全局上传进度 UI 推荐挂在应用根部，或接入 Zustand、Redux 等全局状态。

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
- `HashAdapter` 必须完整响应 `AbortSignal`。如果采用 Web Worker 计算 hash，在收到 `abort` 事件时必须调用 `worker.terminate()` 强制释放线程，不能只丢弃 Promise。

### 7.3 请求适配

SDK 不直接依赖 `fetch`、`axios` 或其他请求库。调用方通过 `request` adapter 统一处理：

- `baseURL`
- cookie 鉴权
- headers
- 网关错误处理
- `AbortSignal`
- 超时控制
- HTTP 状态码或可分类的业务错误码

### 7.4 白名单校验

`whiteList` 只作为体验层面的前端预过滤，不作为安全边界。

- 前端建议优先按文件后缀名校验，例如 `.pdf,.docx,.xlsx`，避免部分浏览器或设备返回空 `file.type`。
- MIME type 可作为辅助信息，但不能作为唯一判断依据。
- 文件安全性、真实格式、内容合法性必须由服务端在 `init` 或 `merge` 阶段最终校验。

### 7.5 超时与重试分层

不同接口的耗时特征不同，不能使用同一套重试策略：

- `init`：请求体较小，建议提供独立的 `initTimeout` 和 `initMaxRetries`。
- `upload`：以分片为单位重试，失败后只重传当前分片。
- `merge`：服务端可能需要合并大量分片，建议提供独立的 `mergeTimeout` 和 `mergeMaxRetries`。

SDK 内部必须区分可恢复错误和致命错误：

- 可重试：网络断开、请求超时、`408`、`429`、`502`、`503`、`504`。
- 快速失败：`400`、`401`、`403`、`404`、`409`、`413`、`415` 等客户端错误或业务明确拒绝的错误。
- `401/403` 应立即停止任务并抛出鉴权/权限错误，交由业务侧刷新登录态或提示用户。
- `413/415` 应立即停止任务，提示文件大小或类型不符合服务端规则。

如果服务端合并耗时较长，推荐将 `merge` 改造成异步任务接口：前端提交合并任务后轮询合并状态，避免网关超时导致前端无法判断最终结果。

### 7.6 服务端幂等性要求

前端会对 `merge` 执行独立重试，因此服务端 `merge` 接口必须具备幂等性：

- 同一个 `docId + checkCode` 重复调用 `merge`，如果文件已合并完成，应直接返回 `200 success`。
- 如果第一次 `merge` 已完成但响应在网关层超时，第二次 `merge` 不能因为临时分片已删除而返回失败。
- 如果服务端处于合并中状态，应返回可识别的处理中状态，或保持请求直到成功/失败。
- 服务端应有临时分片清理策略，清理窗口需要大于前端缓存过期时间。

### 7.7 并发控制

- 默认 `concurrency` 建议为 `3`。
- 推荐允许配置 `minConcurrency` 和 `maxConcurrency`，默认范围为 `1-4`。
- V1 可以采用固定并发，但必须限制最大并发，避免调用方配置过大导致浏览器连接排队或弱网下集中超时。
- 高阶版本可加入拥塞控制：连续出现超时或 `502/503/504` 时自动降低并发；网络恢复稳定后再逐步提升，但不超过 `maxConcurrency`。

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
  status: UploadTaskState;
};
```

恢复上传时，SDK 先通过非 hash 缓存 key 查询任务，信任本地缓存中的 `uploadedChunks`，跳过已成功分片，只上传未完成分片。整文件 hash 仍会在恢复流程中计算，用于后续 `merge` 校验和缓存内容一致性确认。合并成功后删除缓存。

缓存 adapter 使用对象类型交互，序列化和存储细节由调用方负责。这样 SDK 不强制调用方必须使用字符串存储，也避免 getter/setter 类型不一致。

为避免僵尸缓存长期占用本地存储，SDK 初始化时提供 `cacheExpireDays` 配置，默认建议为 `7` 天。`createLargeFileUploader` 启动后应清理超过过期时间且未更新的上传缓存；清理时只删除本地缓存，服务端临时分片由后端 TTL 任务负责回收。

## 9. 异常与重试策略

- 分片上传失败后自动重试。
- 默认最大重试次数建议为 `3`。
- 超过重试次数后任务失败，并保留缓存。
- 只有可恢复错误进入重试；鉴权、权限、文件类型、文件大小等致命错误必须 Fail Fast。
- `pause()` 停止调度新的分片，并通过 `AbortController.abort()` 取消正在上传的分片请求。被取消的分片标记为未完成，恢复时重新上传。
- `resume()` 继续调度剩余分片。
- `cancel({ clearCache = true })` 中止请求并停止任务，默认删除缓存，符合用户主动放弃上传的语义。
- `cancel({ clearCache: false })` 中止请求并停止任务，但保留缓存，适用于业务希望稍后恢复的场景。
- `merge` 失败时不删除缓存，按照独立的 merge 重试策略处理。超过重试次数后任务进入失败态，由业务 UI 提示用户重试或稍后恢复。

## 10. 测试建议

- 首次上传完整成功。
- 零字节文件直接失败，不调用 hash、init、upload 或 merge。
- 小于单分片大小的文件按服务端能力选择普通直传或单分片流程。
- 上传一部分后刷新页面，恢复时跳过已上传分片。
- 分片失败后自动重试并最终成功。
- `401/403/415/413` 等致命错误不会重试，任务快速失败。
- `502/503/504`、超时和网络错误会按策略重试。
- 分片超过最大重试次数后任务失败且缓存保留。
- `pause()` 后不再调度新分片，并取消正在上传的分片请求。
- `pause()` 后 `task.promise` 保持 pending。
- `resume()` 后继续上传剩余分片，并复用原 `task.promise`。
- `cancel()` 后请求被中止，`task.promise` 以 `CancelError` reject，默认删除缓存。
- `cancel({ clearCache: false })` 后请求被中止，`task.promise` 以 `CancelError` reject，但缓存保留。
- `merge` 成功后缓存被删除。
- `merge` 超时后按独立策略重试，最终失败时缓存保留。
- 服务端在已合并完成后收到重复 `merge` 请求，应返回成功。
- GB 级文件 hash 计算期间 React UI 不阻塞。
- 刷新恢复时无需先完成整文件 hash 才能命中缓存。
- Hook 所在组件卸载后不再触发该组件的状态更新。
- 全局单例上传任务在路由切换后继续运行。
- 超过 `cacheExpireDays` 的本地上传缓存会被自动清理。
- Hash 阶段执行 `pause()` 或 `cancel()` 时，Worker 被 `terminate()`，CPU 不再继续消耗。
- `whiteList` 对空 MIME type 文件仍能按后缀名处理，最终安全校验由服务端完成。
- `concurrency` 超出允许范围时被限制或抛出配置错误；弱网连续超时时可降低并发。
