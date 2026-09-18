/**
 * Same rationale as pcmDownsample.test.ts: no vitest configured in client/,
 * so this is a plain node:test unit test against GaplessAudioQueue's
 * MinimalAudioContext seam (no real Web Audio / jsdom needed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GaplessAudioQueue } from '../audioScheduler.ts';
import type { MinimalAudioContext, MinimalSourceNode, MinimalAudioBuffer } from '../audioScheduler.ts';

function makeBuffer(duration: number): MinimalAudioBuffer {
  return { duration };
}

/** Records every scheduled source's start time and duration for assertions. */
class FakeAudioContext implements MinimalAudioContext {
  currentTime = 0;
  destination = {};
  started: { startAt: number; duration: number }[] = [];
  stopped: MinimalSourceNode[] = [];

  createBufferSource(): MinimalSourceNode {
    const ctx = this;
    let buf: MinimalAudioBuffer | null = null;
    const node: MinimalSourceNode = {
      buffer: null,
      onended: null,
      connect() {},
      start(when = 0) {
        buf = node.buffer;
        ctx.started.push({ startAt: when, duration: buf ? buf.duration : 0 });
      },
      stop() {
        ctx.stopped.push(node);
      },
    };
    return node;
  }
}

test('schedules the first chunk at currentTime', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(0.5));
  assert.equal(ctx.started.length, 1);
  assert.equal(ctx.started[0].startAt, 0);
});

test('schedules subsequent in-order chunks back to back with no gap', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(0.5));
  queue.enqueue(1, makeBuffer(0.3));
  queue.enqueue(2, makeBuffer(0.2));

  assert.equal(ctx.started.length, 3);
  assert.equal(ctx.started[0].startAt, 0);
  assert.equal(ctx.started[1].startAt, 0.5);
  assert.equal(ctx.started[2].startAt, 0.8);
});

test('buffers out-of-order chunks and only schedules a contiguous run', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);

  queue.enqueue(1, makeBuffer(0.3)); // arrives before seq 0, must wait
  assert.equal(ctx.started.length, 0, 'seq 1 should not play before seq 0 arrives');

  queue.enqueue(0, makeBuffer(0.5)); // now 0 and 1 are contiguous
  assert.equal(ctx.started.length, 2);
  assert.equal(ctx.started[0].startAt, 0);
  assert.equal(ctx.started[1].startAt, 0.5);
});

test('a chunk arriving after a gap-filler still lands in order', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);

  queue.enqueue(2, makeBuffer(0.1));
  queue.enqueue(0, makeBuffer(0.4));
  assert.equal(ctx.started.length, 1, 'only seq 0 is contiguous so far');

  queue.enqueue(1, makeBuffer(0.2)); // fills the gap, unlocks 1 and 2
  assert.equal(ctx.started.length, 3);
  assert.equal(ctx.started[0].startAt, 0);
  assert.equal(ctx.started[1].startAt, 0.4);
  assert.ok(Math.abs(ctx.started[2].startAt - 0.6) < 1e-9, `${ctx.started[2].startAt}`);
});

test('scheduling never starts a chunk before ctx.currentTime, even if behind', () => {
  const ctx = new FakeAudioContext();
  ctx.currentTime = 5; // playback started, real clock has moved on
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(0.2));
  assert.equal(ctx.started[0].startAt, 5);
});

test('stopAll clears pending chunks and stops active sources; new chunks restart at currentTime', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(1));
  queue.enqueue(2, makeBuffer(1)); // held back, waiting on seq 1

  queue.stopAll();
  assert.equal(ctx.stopped.length, 1, 'the one active source should be stopped');

  ctx.currentTime = 2;
  queue.enqueue(0, makeBuffer(0.5)); // a fresh utterance restarts sequencing at 0
  assert.equal(ctx.started.length, 2);
  assert.equal(ctx.started[1].startAt, 2);
});

test('a stale seq below the reset point is dropped, not scheduled', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(0.5));
  queue.enqueue(1, makeBuffer(0.5));
  queue.stopAll();
  // A late-arriving chunk from the interrupted utterance must not play.
  queue.enqueue(1, makeBuffer(0.5));
  assert.equal(ctx.started.length, 2, 'no new source scheduled for the stale chunk');
});

test('muted mode still advances the schedule and calls onChunkStart, but plays nothing', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.setMuted(true);
  const started: number[] = [];
  queue.onChunkStart = (seq) => started.push(seq);

  queue.enqueue(0, makeBuffer(0.5));
  queue.enqueue(1, makeBuffer(0.5));

  assert.equal(ctx.started.length, 0, 'muted queue should not create real sources');
  assert.deepEqual(started, [0, 1]);
});
