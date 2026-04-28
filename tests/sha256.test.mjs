import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../dist/sha256.js';

test('sha256Hex returns a known SHA-256 digest', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
