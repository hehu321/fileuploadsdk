# fileuploadsdk

前端大文件分片上传 SDK。源码可以直接拷贝到现有 React 16.13 项目中使用。

## React 16.13 接入

React 16.13 已支持 Hooks，本 SDK 的 React 封装不依赖 React 18 API。

推荐把 `src/` 目录复制到业务项目中，例如：

```text
src/shared/file-upload-sdk/
```

核心 SDK：

```ts
import { createLargeFileUploader } from '@/shared/file-upload-sdk';
```

React Hook：

```ts
import { useLargeFileUpload } from '@/shared/file-upload-sdk/react';
```

如果业务项目不需要 Hook，只使用核心 SDK 即可，不需要引入 `react.ts`。

## 运行要求

- TypeScript 项目或支持 TS/ES module 的前端构建链路。
- 浏览器环境需要支持 `Blob`、`FormData`、`AbortController`、`Worker`。
- 如果目标浏览器不支持 `AbortController` 或 `Worker`，业务项目需要提供 polyfill 或注入自定义 `hash` 方法。

## 本地验证

```bash
npm run typecheck
npm test
```
