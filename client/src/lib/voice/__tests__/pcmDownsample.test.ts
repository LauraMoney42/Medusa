/**
 * No vitest is configured in client/ (package.json has no test script or
 * dependency), so per the S14-C quality bar this is "a small node test"
 * instead: plain node:test + node:assert, runnable with
 * `node --test src/lib/voice/__tests__/*.test.ts` (Node 22.6+/23+ strips
 * these type annotations natively; no ts-node or build step needed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleLinear,
  floatSampleToInt16,
  floatTo16kPCM16,
  applyEchoGuard,
  TARGET_SAMPLE_RATE,
} from '../pcmDownsample.ts';

test('resampleLinear is a no-op when rates match', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const out = resampleLinear(input, 16000, 16000);
  assert.deepEqual(Array.from(out), Array.from(input));
});

test('resampleLinear halves the sample count when downsampling 2x', () => {
  const input = new Float32Array(200).map((_, i) => Math.sin(i / 10));
  const out = resampleLinear(input, 32000, 16000);
  assert.ok(Math.abs(out.length - 100) <= 1, `expected ~100 samples, got ${out.length}`);
});

test('resampleLinear from 48000 to 16000 (mic default) produces 1/3 the samples', () => {
  const input = new Float32Array(4800); // 100ms at 48kHz
  const out = resampleLinear(input, 48000, TARGET_SAMPLE_RATE);
  assert.ok(Math.abs(out.length - 1600) <= 1, `expected ~1600 samples, got ${out.length}`);
});

test('resampleLinear handles empty input', () => {
  const out = resampleLinear(new Float32Array(0), 48000, 16000);
  assert.equal(out.length, 0);
});

test('floatSampleToInt16 clamps and scales into the int16 range', () => {
  assert.equal(floatSampleToInt16(0), 0);
  assert.equal(floatSampleToInt16(1), 0x7fff);
  assert.equal(floatSampleToInt16(-1), -0x8000);
  assert.equal(floatSampleToInt16(2), 0x7fff); // clamped
  assert.equal(floatSampleToInt16(-2), -0x8000); // clamped
});

test('floatTo16kPCM16 end to end: known sine wave stays in range and in length ballpark', () => {
  const sr = 48000;
  const durationMs = 100;
  const n = Math.round((sr * durationMs) / 1000);
  const input = new Float32Array(n);
  for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5;

  const pcm = floatTo16kPCM16(input, sr);
  const expectedLen = Math.round((TARGET_SAMPLE_RATE * durationMs) / 1000);
  assert.ok(Math.abs(pcm.length - expectedLen) <= 2, `length ${pcm.length} vs expected ${expectedLen}`);
  for (const sample of pcm) {
    assert.ok(sample >= -0x8000 && sample <= 0x7fff);
  }
});

test('applyEchoGuard scales samples down by the duck factor', () => {
  const pcm = new Int16Array([1000, -1000, 32767]);
  const ducked = applyEchoGuard(pcm, 0.5);
  assert.equal(ducked[0], 500);
  assert.equal(ducked[1], -500);
  assert.equal(ducked[2], Math.round(32767 * 0.5));
});

test('applyEchoGuard is a no-op at factor 1', () => {
  const pcm = new Int16Array([123, -456]);
  const out = applyEchoGuard(pcm, 1);
  assert.deepEqual(Array.from(out), Array.from(pcm));
});

test('applyEchoGuard silences at factor 0', () => {
  const pcm = new Int16Array([123, -456, 999]);
  const out = applyEchoGuard(pcm, 0);
  assert.deepEqual(Array.from(out), [0, 0, 0]);
});
