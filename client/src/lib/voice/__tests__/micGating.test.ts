/**
 * Which tier is allowed to hold the mic back.
 *
 * Bug: in Live mode the echo guard ducked the sent mic to 0.15 and the
 * `EchoGate` then withheld every frame for the whole of her reply. Gemini's own
 * VAD, which is the only thing deciding whose turn it is in that tier, got
 * near-silence and never saw the user's next utterance start, so the
 * conversation died after one round trip. These tests walk a full turn cycle
 * frame by frame and insist nothing is dropped in live tier.
 *
 * Plain node:test, like the other tests here: no vitest in client/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  micGateFor,
  ownsTurnTaking,
  reportsLocalBargeIn,
  sentGainFor,
  type MicGateInputs,
} from '../micGating.ts';

const settings: Omit<MicGateInputs, 'tier'> = {
  echoGuardEnabled: true,
  echoGuardDuckFactor: 0.15,
  bargeInEnergyThreshold: 2000,
  bargeInMinSpeechMs: 300,
};

/** One 100 ms frame of 16 kHz PCM16 at a constant amplitude. */
function frame(amplitude: number): Int16Array {
  return new Int16Array(1600).fill(amplitude);
}

/**
 * The client's own send path, reduced to the decision under test: what
 * `VoiceMicButton.sendFrame` would put on the socket for each captured frame,
 * with the echo guard's outgoing gain actually applied.
 */
function runTurnCycle(tier: MicGateInputs['tier']) {
  const gate = micGateFor({ tier, ...settings });
  const sent: Int16Array[] = [];
  const interrupts: string[] = [];
  let speaking = false;

  const setSpeaking = (next: boolean) => {
    speaking = next;
    gate?.setSpeaking(next);
  };
  const capture = (amplitude: number) => {
    const gain = sentGainFor({ tier, ...settings }, speaking);
    const raw = frame(Math.round(amplitude * gain));
    if (!gate) {
      sent.push(raw);
      return;
    }
    const wasOpen = gate.isOpen;
    const frames = gate.accept(raw);
    if (!wasOpen && gate.isOpen && reportsLocalBargeIn(tier)) interrupts.push('voice:interrupt');
    for (const f of frames) sent.push(f);
  };

  return { sent, interrupts, setSpeaking, capture, gate };
}

test('turn-taking belongs to Medusa on the pipeline tier and to Gemini in live mode', () => {
  assert.equal(ownsTurnTaking('pipeline'), true);
  assert.equal(ownsTurnTaking('live'), false);
  // Before `voice:tier` arrives the safe assumption is the local loop.
  assert.equal(ownsTurnTaking(null), true);
});

test('no echo gate is ever built in live tier', () => {
  assert.equal(micGateFor({ tier: 'live', ...settings }), null);
  assert.notEqual(micGateFor({ tier: 'pipeline', ...settings }), null);
  // The echo guard switch still turns it off on the pipeline tier.
  assert.equal(micGateFor({ tier: 'pipeline', ...settings, echoGuardEnabled: false }), null);
});

test('the outgoing mic is never ducked in live tier, speaking or not', () => {
  assert.equal(sentGainFor({ tier: 'live', ...settings }, true), 1);
  assert.equal(sentGainFor({ tier: 'live', ...settings }, false), 1);
  assert.equal(sentGainFor({ tier: 'pipeline', ...settings }, true), 0.15);
  assert.equal(sentGainFor({ tier: 'pipeline', ...settings }, false), 1);
});

test('live tier: every mic frame flows across a full turn cycle (user, her, user again)', () => {
  const c = runTurnCycle('live');

  // 1. The user's first turn.
  for (let i = 0; i < 5; i++) c.capture(6000);
  assert.equal(c.sent.length, 5);

  // 2. Her reply. Only her own echo is in the room, and it still goes out:
  // Gemini's VAD is what decides whether that counts as the user talking.
  c.setSpeaking(true);
  for (let i = 0; i < 10; i++) c.capture(400);
  assert.equal(c.sent.length, 15);

  // 3. The user's second turn, first over the top of the reply and then after
  // it. This is the stretch that used to reach the model as silence.
  for (let i = 0; i < 5; i++) c.capture(6000);
  c.setSpeaking(false);
  for (let i = 0; i < 5; i++) c.capture(6000);

  assert.equal(c.sent.length, 25);
  // Full amplitude throughout: no duck was applied on the way out.
  assert.equal(c.sent[0][0], 6000);
  assert.equal(c.sent[c.sent.length - 1][0], 6000);
  assert.ok(c.sent.every((f) => f.length === 1600));
  // And the client raised no interruption of its own: Gemini raises that.
  assert.deepEqual(c.interrupts, []);
});

test('pipeline tier still gates her echo and reports a real barge-in', () => {
  const c = runTurnCycle('pipeline');

  for (let i = 0; i < 3; i++) c.capture(6000);
  assert.equal(c.sent.length, 3);

  c.setSpeaking(true);
  // Her own echo, at the ducked level, is held back.
  for (let i = 0; i < 10; i++) c.capture(400);
  assert.equal(c.sent.length, 3);

  // Real speech, sustained past the measurement window and minSpeechMs, opens
  // the gate and tells the server.
  for (let i = 0; i < 6; i++) c.capture(30000);
  assert.ok(c.sent.length > 3);
  assert.deepEqual(c.interrupts, ['voice:interrupt']);
});
