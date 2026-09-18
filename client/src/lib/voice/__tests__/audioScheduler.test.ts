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

// Single speaker ownership (turnId). Reproduces the "heard the same reply
// twice ... with overlap" and "sometimes shows no response" bugs: without a
// turnId, `seq` alone can't tell two turns apart once a turn ends normally
// (no `stopAll`/reset happens) or when an old turn's chunk is still in
// flight when the new one starts.
test('beginTurn on a genuinely new id stops whatever the previous turn left playing/queued', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.beginTurn('turn-a');
  queue.enqueue(0, makeBuffer(1), 'turn-a');
  queue.enqueue(2, makeBuffer(1), 'turn-a'); // held back, waiting on seq 1

  queue.beginTurn('turn-b');
  assert.equal(ctx.stopped.length, 1, 'turn-a\'s active source must be hard-stopped');

  // turn-b's own seq-0 chunk plays even though turn-a never got past seq 0:
  // a fresh turn is never rejected as "stale" by a leftover nextExpectedSeq.
  ctx.currentTime = 1;
  queue.enqueue(0, makeBuffer(0.5), 'turn-b');
  assert.equal(ctx.started.length, 2);
  assert.equal(ctx.started[1].startAt, 1);
});

test('a chunk tagged with a turn other than the current one is dropped, even with a fresh seq', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.beginTurn('turn-a');
  queue.enqueue(0, makeBuffer(1), 'turn-a');

  queue.beginTurn('turn-b');
  queue.enqueue(0, makeBuffer(1), 'turn-b');
  assert.equal(ctx.started.length, 2);

  // turn-a's chunk 1, straggling in late (already superseded): must never
  // play alongside turn-b's audio.
  queue.enqueue(1, makeBuffer(1), 'turn-a');
  assert.equal(ctx.started.length, 2, 'the stale turn-a chunk must not be scheduled');
});

// This is the exact "sometimes shows no response" scenario: a turn ends
// normally (nothing ever calls stopAll for it), so nextExpectedSeq is left
// wherever that turn's last chunk put it, and the next turn's own seq-0
// chunk must still be accepted rather than rejected as "stale".
test('a turn that ends normally does not poison the next turn\'s seq-0 chunk', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.beginTurn('turn-a');
  queue.enqueue(0, makeBuffer(1), 'turn-a');
  queue.enqueue(1, makeBuffer(1), 'turn-a');
  queue.enqueue(2, makeBuffer(1), 'turn-a');
  assert.equal(ctx.started.length, 3);

  // No stopAll() here: this is what a normal (non-interrupted) end looks
  // like. The next turn starts and its own speaking-start switches the turn.
  queue.beginTurn('turn-b');
  queue.enqueue(0, makeBuffer(1), 'turn-b');
  assert.equal(ctx.started.length, 4, 'turn-b seq 0 must be scheduled, not dropped as stale');
});

test('calling beginTurn again with the same id is a no-op (does not stop mid-turn audio)', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.beginTurn('turn-a');
  queue.enqueue(0, makeBuffer(1), 'turn-a');
  queue.beginTurn('turn-a'); // e.g. a redundant speaking-start re-delivery
  assert.equal(ctx.stopped.length, 0, 'the same turn id must not be treated as a turn change');
  queue.enqueue(1, makeBuffer(1), 'turn-a');
  assert.equal(ctx.started.length, 2);
});

test('a chunk with no turnId (older server) is accepted like before, ignoring turn tracking', () => {
  const ctx = new FakeAudioContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.enqueue(0, makeBuffer(0.5));
  queue.enqueue(1, makeBuffer(0.5));
  assert.equal(ctx.started.length, 2);
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
