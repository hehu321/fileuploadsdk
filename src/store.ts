import type { UploadTask, UploadTaskSnapshot } from './types';

export type UploadStore = {
  add(task: UploadTask): () => void;
  getSnapshot(): UploadTaskSnapshot[];
  subscribe(listener: (snapshot: UploadTaskSnapshot[]) => void): () => void;
};

export function createUploadStore(): UploadStore {
  const tasks = new Set<UploadTask>();
  const listeners = new Set<(snapshot: UploadTaskSnapshot[]) => void>();
  const unsubscribers = new Map<UploadTask, () => void>();

  const emit = () => {
    const snapshot = Array.from(tasks, (task) => task.getState());
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  return {
    add(task) {
      tasks.add(task);
      unsubscribers.set(task, task.subscribe(emit));
      emit();
      return () => {
        tasks.delete(task);
        unsubscribers.get(task)?.();
        unsubscribers.delete(task);
        emit();
      };
    },
    getSnapshot() {
      return Array.from(tasks, (task) => task.getState());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
