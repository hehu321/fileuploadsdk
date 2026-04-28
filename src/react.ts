// @ts-nocheck
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLargeFileUploader } from './uploader';
import type { LargeFileUploaderOptions, UploadOptions, UploadTask, UploadTaskSnapshot } from './types';

export type UseLargeFileUploadOptions = LargeFileUploaderOptions & {
  pauseOnUnmount?: boolean;
};

export type UseLargeFileUploadReturn = {
  upload: (file: Blob, options?: UploadOptions) => UploadTask;
  pause: () => void;
  resume: () => void;
  cancel: (options?: { clearCache?: boolean }) => void;
  task: UploadTask | null;
  state: UploadTaskSnapshot['state'];
  progress: UploadTaskSnapshot['progress'];
  error: UploadTaskSnapshot['error'];
};

export function useLargeFileUpload(options: UseLargeFileUploadOptions): UseLargeFileUploadReturn {
  const uploaderRef = useRef<ReturnType<typeof createLargeFileUploader> | null>(null);
  const taskRef = useRef<UploadTask | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [snapshot, setSnapshot] = useState<UploadTaskSnapshot>({
    state: 'idle',
    progress: null,
    error: null,
  });
  if (!uploaderRef.current) {
    uploaderRef.current = createLargeFileUploader(options);
  }

  const bindTask = useCallback((task: UploadTask) => {
    unsubscribeRef.current?.();
    taskRef.current = task;
    unsubscribeRef.current = task.subscribe(setSnapshot);
  }, []);

  const upload = useCallback(
    (file: Blob, uploadOptions: UploadOptions = {}) => {
      const task = uploaderRef.current!.upload(file, uploadOptions);
      bindTask(task);
      return task;
    },
    [bindTask],
  );

  const pause = useCallback(() => {
    taskRef.current?.pause();
  }, []);

  const resume = useCallback(() => {
    taskRef.current?.resume();
  }, []);

  const cancel = useCallback((cancelOptions?: { clearCache?: boolean }) => {
    taskRef.current?.cancel(cancelOptions);
  }, []);

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      if (options.pauseOnUnmount) {
        taskRef.current?.pause();
      }
    };
  }, [options.pauseOnUnmount]);

  return {
    upload,
    pause,
    resume,
    cancel,
    task: taskRef.current,
    state: snapshot.state,
    progress: snapshot.progress,
    error: snapshot.error,
  };
}
