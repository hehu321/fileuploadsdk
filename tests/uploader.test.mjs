import test from 'node:test';
import assert from 'node:assert/strict';
import { createLargeFileUploader, CancelError, UploadSdkError } from '../dist/index.js';

function createMemoryCache() {
  const map = new Map();
  return {
    map,
    getPrivateDb: async (key) => map.get(key) ?? null,
    savePrivateDb: async (key, value) => {
      map.set(key, value);
    },
    deletePrivateDb: async (key) => {
      map.delete(key);
    },
  };
}

test('zero-byte files fail before requests are sent', async () => {
  const cache = createMemoryCache();
  const requests = [];
  const uploader = createLargeFileUploader({
    projectId: 'p1',
    request: async (config) => {
      requests.push(config);
      return { status: 200, message: 'success', result: null };
    },
    hash: async () => 'hash',
    ...cache,
  });

  const task = uploader.upload(new Blob([]), { fileName: 'empty.pdf' });
  await assert.rejects(task.promise, (error) => error instanceof UploadSdkError && error.code === 'EMPTY_FILE');
  assert.equal(requests.length, 0);
});

test('uploads chunks then merges successfully', async () => {
  const cache = createMemoryCache();
  const calls = [];
  const uploader = createLargeFileUploader({
    projectId: 'p1',
    request: async (config) => {
      calls.push(config.url);
      if (config.url.endsWith('type=init')) {
        return { status: 200, message: 'success', result: { docId: 'doc-1' } };
      }
      return { status: 200, message: 'success', result: null };
    },
    hash: async (blob) => `hash-${blob.size}`,
    concurrency: 2,
    ...cache,
  });

  const task = uploader.upload(new Blob(['abcdef']), {
    fileName: 'demo.txt',
    chunkSize: 3,
  });

  const result = await task.promise;
  assert.equal(result.docId, 'doc-1');
  assert.deepEqual(calls, [
    '/projects/p1/chunk/documents?type=init',
    '/projects/p1/chunk/documents?type=upload',
    '/projects/p1/chunk/documents?type=upload',
    '/projects/p1/chunk/documents?type=merge',
  ]);
  assert.equal(cache.map.size, 0);
});

test('cancel rejects with CancelError and clears cache by default', async () => {
  const cache = createMemoryCache();
  const uploader = createLargeFileUploader({
    projectId: 'p1',
    request: async () => new Promise(() => {}),
    hash: async () => 'hash',
    ...cache,
  });

  const task = uploader.upload(new Blob(['abcdef']), {
    fileName: 'demo.txt',
    chunkSize: 3,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  task.cancel();
  await assert.rejects(task.promise, (error) => error instanceof CancelError);
  assert.equal(cache.map.size, 0);
});
