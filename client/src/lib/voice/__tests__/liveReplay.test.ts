/**
 * Replays a real Gemini Live session through the scheduler.
 *
 * `liveChunkTrace.json` is the exact `voice:speaking-start` /
 * `voice:audio-chunk` / `voice:stop-audio` / `voice:speaking-end` sequence a
 * headless client recorded against the live service on 2026-09-18 (two spoken
 * turns, the first one cut off by a barge-in), with the ids anonymised and
 * the timestamps made relative. Live mode used to send none of those turnIds,
 * which is what let two turns play at once; this proves the recorded stream
 * schedules as one speaker with no overlap.
 *
 * Plain node:test, like the other tests here: no vitest in client/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GaplessAudioQueue } from '../audioScheduler.ts';
import type { MinimalAudioContext, MinimalSourceNode, MinimalAudioBuffer } from '../audioScheduler.ts';

interface TraceEvent {
  t: number;
  kind: 'speaking-start' | 'speaking-end' | 'stop-audio' | 'chunk';
  turnId?: string;
  seq?: number;
  durationMs?: number;
}

const trace = JSON.parse(
  readFileSync(new URL('./liveChunkTrace.json', import.meta.url), 'utf-8'),
) as TraceEvent[];

/** Records every scheduled source so overlap can be checked afterwards. */
class ReplayContext implements MinimalAudioContext {
  currentTime = 0;
  destination = {};
  started: { startAt: number; duration: number; node: MinimalSourceNode }[] = [];
  stoppedAt = new Map<MinimalSourceNode, number>();

  createBufferSource(): MinimalSourceNode {
    const ctx = this;
    const node: MinimalSourceNode = {
      buffer: null,
      onended: null,
      connect() {},
      start(when = 0) {
        ctx.started.push({ startAt: when, duration: node.buffer?.duration ?? 0, node });
      },
      stop() {
        ctx.stoppedAt.set(node, ctx.currentTime);
      },
    };
    return node;
  }
}

/**
 * One scheduled buffer, with the window in which it is actually audible:
 * chunks are scheduled well ahead of the clock (the service delivers a whole
 * reply in a fraction of its spoken length), so a source stopped by a
 * barge-in is audible only up to the moment it was stopped, and one whose
 * start time was still in the future is never heard at all.
 */
interface Audible {
  turnId: string;
  startAt: number;
  end: number;
}

function replay(): { ctx: ReplayContext; scheduled: Audible[] } {
  const ctx = new ReplayContext();
  const queue = new GaplessAudioQueue(ctx);
  const scheduled: Audible[] = [];
  const nodes: { node: MinimalSourceNode; entry: Audible }[] = [];

  for (const ev of trace) {
    ctx.currentTime = ev.t / 1000; // the wall clock the browser would be on
    switch (ev.kind) {
      case 'speaking-start':
        queue.beginTurn(ev.turnId!);
        break;
      case 'stop-audio':
        queue.stopAll(ev.turnId);
        break;
      case 'speaking-end':
        break;
      case 'chunk': {
        const before = ctx.started.length;
        const buffer: MinimalAudioBuffer = { duration: (ev.durationMs ?? 0) / 1000 };
        queue.enqueue(ev.seq!, buffer, ev.turnId);
        if (ctx.started.length > before) {
          const s = ctx.started[ctx.started.length - 1];
          scheduled.push({ turnId: ev.turnId!, startAt: s.startAt, end: s.startAt + s.duration });
          nodes.push({ node: s.node, entry: scheduled[scheduled.length - 1] });
        }
        break;
      }
    }
  }
  // Clip every stopped source to the moment it was stopped, and drop the ones
  // that never began playing.
  for (const { node, entry } of nodes) {
    const stoppedAt = ctx.stoppedAt.get(node);
    if (stoppedAt === undefined) continue;
    entry.end = Math.min(entry.end, stoppedAt);
    if (entry.startAt >= stoppedAt) entry.end = entry.startAt; // never heard
  }
  return { ctx, scheduled: scheduled.filter((s) => s.end > s.startAt) };
}

test('the recorded live session carries a turnId on every chunk and speaking-start', () => {
  assert.ok(trace.some((e) => e.kind === 'chunk'));
  for (const ev of trace) {
    assert.ok(ev.turnId, `${ev.kind} at ${ev.t} has no turnId`);
  }
});

test('replaying it schedules one speaker: no two buffers ever overlap in time', () => {
  const { scheduled } = replay();
  assert.ok(scheduled.length > 20, 'expected the recorded chunks to be scheduled');
  const byStart = [...scheduled].sort((a, b) => a.startAt - b.startAt);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const next = byStart[i];
    // Floating point: allow a microsecond of slop, nothing audible.
    assert.ok(
      next.startAt >= prev.end - 1e-6,
      `chunk starting at ${next.startAt} overlaps one running until ${prev.end}`,
    );
  }
});

test('a new turn never starts before the audible part of the previous one ends', () => {
  const { scheduled } = replay();
  const turns = [...new Set(scheduled.map((s) => s.turnId))];
  assert.ok(turns.length >= 2, 'the recording has more than one turn');
  for (let i = 1; i < turns.length; i++) {
    const prevEnd = Math.max(...scheduled.filter((s) => s.turnId === turns[i - 1]).map((s) => s.end));
    const nextStart = Math.min(...scheduled.filter((s) => s.turnId === turns[i]).map((s) => s.startAt));
    assert.ok(nextStart >= prevEnd - 1e-6, `${turns[i]} starts before ${turns[i - 1]} finishes`);
  }
});

test('an interrupted turn stops playing and its late chunks are refused', () => {
  const stop = trace.find((e) => e.kind === 'stop-audio');
  assert.ok(stop, 'the recorded session contains a barge-in');
  const { ctx, scheduled } = replay();
  assert.ok(ctx.stoppedAt.size > 0, 'the interrupted turn was stopped');
  // Nothing from the stopped turn may still be audible after the stop landed.
  const stoppedTurn = stop!.turnId!;
  const stopTime = stop!.t / 1000;
  for (const s of scheduled) {
    if (s.turnId === stoppedTurn) {
      assert.ok(s.end <= stopTime + 1e-9, 'the interrupted turn kept playing past the stop');
    }
  }
});

test('a chunk that finishes decoding after its turn was stopped is dropped', () => {
  const ctx = new ReplayContext();
  const queue = new GaplessAudioQueue(ctx);
  queue.beginTurn('turn-1');
  queue.enqueue(0, { duration: 0.2 }, 'turn-1');
  queue.stopAll('turn-1');
  // Late arrival: decodeAudioData resolved after the stop-audio landed.
  queue.enqueue(1, { duration: 0.2 }, 'turn-1');
  queue.beginTurn('turn-2');
  queue.enqueue(0, { duration: 0.2 }, 'turn-2');
  assert.equal(ctx.started.length, 2, 'only turn-1 seq 0 and turn-2 seq 0 should play');
});
