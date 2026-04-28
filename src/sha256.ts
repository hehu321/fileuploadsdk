import { CancelError } from './errors';
import type { HashAdapter } from './types';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

const rotr = (value: number, shift: number) => (value >>> shift) | (value << (32 - shift));

export class Sha256 {
  private readonly h = new Uint32Array(INITIAL);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error('SHA-256 instance already finalized');
    }

    let position = 0;
    this.bytesHashed += data.length;

    while (position < data.length) {
      const take = Math.min(data.length - position, 64 - this.blockLength);
      this.block.set(data.subarray(position, position + take), this.blockLength);
      this.blockLength += take;
      position += take;

      if (this.blockLength === 64) {
        this.processBlock(this.block);
        this.blockLength = 0;
      }
    }

    return this;
  }

  digest(): Uint8Array {
    if (this.finished) {
      throw new Error('SHA-256 instance already finalized');
    }
    this.finished = true;

    const bitLengthHigh = Math.floor((this.bytesHashed * 8) / 0x100000000);
    const bitLengthLow = (this.bytesHashed * 8) >>> 0;

    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength, 64);
      this.processBlock(this.block);
      this.blockLength = 0;
    }

    this.block.fill(0, this.blockLength, 56);
    writeU32(this.block, 56, bitLengthHigh);
    writeU32(this.block, 60, bitLengthLow);
    this.processBlock(this.block);

    const output = new Uint8Array(32);
    for (let i = 0; i < 8; i += 1) {
      writeU32(output, i * 4, this.h[i] ?? 0);
    }
    return output;
  }

  hex(): string {
    return toHex(this.digest());
  }

  private processBlock(block: Uint8Array): void {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      words[i] = readU32(block, i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15] ?? 0;
      const w2 = words[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[i] = (((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0);
    }

    let a = this.h[0] ?? 0;
    let b = this.h[1] ?? 0;
    let c = this.h[2] ?? 0;
    let d = this.h[3] ?? 0;
    let e = this.h[4] ?? 0;
    let f = this.h[5] ?? 0;
    let g = this.h[6] ?? 0;
    let h = this.h[7] ?? 0;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (K[i] ?? 0) + (words[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = ((this.h[0] ?? 0) + a) >>> 0;
    this.h[1] = ((this.h[1] ?? 0) + b) >>> 0;
    this.h[2] = ((this.h[2] ?? 0) + c) >>> 0;
    this.h[3] = ((this.h[3] ?? 0) + d) >>> 0;
    this.h[4] = ((this.h[4] ?? 0) + e) >>> 0;
    this.h[5] = ((this.h[5] ?? 0) + f) >>> 0;
    this.h[6] = ((this.h[6] ?? 0) + g) >>> 0;
    this.h[7] = ((this.h[7] ?? 0) + h) >>> 0;
  }
}

export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new Sha256().update(bytes).hex();
}

export const defaultHashAdapter: HashAdapter = async (input, options = {}) => {
  if (options.signal?.aborted) {
    throw new CancelError('Hash canceled');
  }

  if (typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    return hashInWorker(input, options.signal, options.onProgress);
  }

  return hashInCurrentThread(input, options.signal, options.onProgress);
};

async function hashInCurrentThread(
  input: Blob,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<string> {
  const chunkSize = 4 * 1024 * 1024;
  const hasher = new Sha256();
  let offset = 0;

  while (offset < input.size) {
    if (signal?.aborted) {
      throw new CancelError('Hash canceled');
    }
    const chunk = input.slice(offset, Math.min(offset + chunkSize, input.size));
    hasher.update(new Uint8Array(await chunk.arrayBuffer()));
    offset += chunk.size;
    onProgress?.(input.size === 0 ? 100 : Math.min(100, (offset / input.size) * 100));
    await yieldToEventLoop();
  }

  return hasher.hex();
}

function hashInWorker(input: Blob, signal?: AbortSignal, onProgress?: (progress: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const workerUrl = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl);
    let settled = false;

    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      signal?.removeEventListener('abort', abort);
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const abort = () => {
      worker.postMessage({ type: 'abort' });
      finish(() => reject(new CancelError('Hash canceled')));
    };

    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; progress?: number; hash?: string; message?: string };
      if (data.type === 'progress' && typeof data.progress === 'number') {
        onProgress?.(data.progress);
      }
      if (data.type === 'done' && typeof data.hash === 'string') {
        const hash = data.hash;
        finish(() => resolve(hash));
      }
      if (data.type === 'error') {
        finish(() => reject(new Error(data.message ?? 'Hash worker failed')));
      }
      if (data.type === 'canceled') {
        finish(() => reject(new CancelError('Hash canceled')));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'Hash worker failed')));
    };

    worker.postMessage({ type: 'hash', file: input, chunkSize: 4 * 1024 * 1024 });
  });
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function workerSource(): string {
  return `
    ${rotr.toString()}
    ${readU32.toString()}
    ${writeU32.toString()}
    ${toHex.toString()}
    const K = new Uint32Array(${JSON.stringify(Array.from(K))});
    const INITIAL = new Uint32Array(${JSON.stringify(Array.from(INITIAL))});
    ${Sha256.toString()}
    let aborted = false;
    self.onmessage = async (event) => {
      if (event.data && event.data.type === 'abort') {
        aborted = true;
        self.postMessage({ type: 'canceled' });
        return;
      }
      if (!event.data || event.data.type !== 'hash') return;
      const file = event.data.file;
      const chunkSize = event.data.chunkSize;
      const hasher = new Sha256();
      let offset = 0;
      try {
        while (offset < file.size) {
          if (aborted) return;
          const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
          hasher.update(new Uint8Array(await chunk.arrayBuffer()));
          offset += chunk.size;
          self.postMessage({ type: 'progress', progress: file.size === 0 ? 100 : Math.min(100, (offset / file.size) * 100) });
        }
        self.postMessage({ type: 'done', hash: hasher.hex() });
      } catch (error) {
        self.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
      }
    };
  `;
}
