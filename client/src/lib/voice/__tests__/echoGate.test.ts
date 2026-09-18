/**
 * The mic gate that keeps her own voice from reaching the realtime model.
 *
 * Measured against the real service on 2026-09-18 with playback fed back into
 * the mic at the echo-guard duck factor: with no gate she cut herself off
 * 0.7 s into her own reply, her own voice came back as a user turn ("WHY DID
 * THE PROGRAMMER-"), and she restarted the sentence. With the gate, zero
 * spurious interruptions across the same script, and a real barge-in still
 * stopped her.
 *
 * Plain node:test, like the other tests here: no vitest in client/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EchoGate, floorFor, frameRms } from '../echoGate.ts';

/** A 100 ms frame of 16 kHz PCM16 at roughly the given RMS. */
function tone(rms: number): Int16Array {
  const f = new Int16Array(1600);
  const amp = rms * Math.SQRT2;
  for (let i = 0; i < f.length; i++) f[i] = Math.round(Math.sin(i / 5) * amp);
  return f;
}

function feed(gate: EchoGate, frame: Int16Array, times: number): number {
  let sent = 0;
  for (let i = 0; i < times; i++) sent += gate.accept(frame).length;
  return sent;
}

test('frameRms and floorFor', () => {
  assert.ok(Math.abs(frameRms(tone(1000)) - 1000) < 60);
  assert.equal(frameRms(new Int16Array(10)), 0);
  // The gate sees ducked frames, so the bar comes down by the duck factor.
  assert.equal(floorFor(2000, 0.15), 300);
  // ...but never below a sane absolute minimum.
  assert.equal(floorFor(100, 0.05), 80);
});

test('everything passes while she is not speaking', () => {
  const gate = new EchoGate({ floor: 300 });
  assert.equal(feed(gate, tone(5), 10), 10);
  assert.equal(gate.isOpen, true);
});

test('her own echo never opens the gate, however loud the speaker is', () => {
  const gate = new EchoGate({ floor: 300 });
  gate.setSpeaking(true);
  // 20 frames (2 s) of steady, loud echo: above the absolute floor, but the
  // adaptive bar is measured from the echo itself.
  assert.equal(feed(gate, tone(2500), 20), 0);
  assert.equal(gate.isOpen, false);
  assert.ok(gate.threshold >= 2500 * 2 * 0.9);
});

test('a person talking over her opens it, and the opening frames are not lost', () => {
  const gate = new EchoGate({ floor: 300 });
  gate.setSpeaking(true);
  feed(gate, tone(400), 6); // the measurement window plus more echo
  const echoOnly = gate.accept(tone(400));
  assert.equal(echoOnly.length, 0);

  const user = tone(4000);
  assert.equal(gate.accept(user).length, 0); // 100 ms is not enough
  assert.equal(gate.accept(user).length, 0); // 200 ms is not enough
  const released = gate.accept(user);
  assert.equal(released.length, 3, 'the 300 ms that opened the gate are released');
  assert.equal(gate.isOpen, true);
});

test('once open it stays open for the rest of the turn, so a barge-in is not chopped', () => {
  const gate = new EchoGate({ floor: 300 });
  gate.setSpeaking(true);
  feed(gate, tone(200), 5);
  feed(gate, tone(4000), 3); // opens
  // A quiet moment mid-sentence must still be forwarded.
  assert.equal(feed(gate, tone(50), 4), 4);
});

test('a single loud thump does not count as speech', () => {
  const gate = new EchoGate({ floor: 300 });
  gate.setSpeaking(true);
  feed(gate, tone(200), 5);
  assert.equal(gate.accept(tone(9000)).length, 0);
  assert.equal(feed(gate, tone(10), 3), 0);
  assert.equal(gate.isOpen, false);
});

test('every turn re-measures the echo floor', () => {
  const gate = new EchoGate({ floor: 300 });
  gate.setSpeaking(true);
  feed(gate, tone(3000), 6);
  const loudTurn = gate.threshold;
  gate.setSpeaking(false);
  gate.setSpeaking(true);
  feed(gate, tone(20), 6);
  assert.ok(gate.threshold < loudTurn, 'a quieter turn lowers the bar again');
  assert.equal(gate.threshold, 300, 'and never below the absolute floor');
});
