/**
 * Who is allowed to gate the outgoing mic, per tier.
 *
 * The two tiers have opposite requirements and used to share one code path,
 * which is what made Live mode talk over the user and then go deaf after one
 * round trip:
 *
 *  - pipeline: Medusa owns turn-taking (server/src/voice/vad.ts and
 *    barge-in.ts). Whisper would happily transcribe her own voice leaking out
 *    of the laptop speaker, so while she speaks the sent mic level is ducked
 *    and the `EchoGate` holds frames back until it hears sustained, real
 *    speech. Gating here costs nothing, because nothing downstream is trying
 *    to detect speech boundaries on the raw stream.
 *
 *  - live: Gemini owns turn-taking. The Live API "automatically performs VAD
 *    on a continuous audio input stream" and reports every interruption as
 *    `serverContent.interrupted`. A duck plus a closed gate means it receives
 *    near-silence for the whole of her reply, so its VAD never sees the user's
 *    next utterance begin: the user speaks again and nothing happens. So in
 *    live tier the mic is never gated and never ducked, whatever the loop
 *    state says. Echo is left to `getUserMedia`'s own `echoCancellation`,
 *    which is the only echo suppression Gemini's own VAD is designed around.
 *
 * Speaker-side muting (`speakerMuted` -> `GaplessAudioQueue.setMuted`) is
 * unaffected on either tier: this module only decides what leaves the mic.
 */

// The `.ts` extension is deliberate: `client/`'s tests are plain node:test runs
// under --experimental-strip-types, which resolves ESM specifiers literally, so
// a module that a test imports may not use extensionless relative imports.
import { EchoGate, floorFor } from './echoGate.ts';

export type VoiceTier = 'live' | 'pipeline' | null;

export interface MicGateInputs {
  /** The tier the server put this chat on. Null before `voice:tier` arrives. */
  tier: VoiceTier;
  echoGuardEnabled: boolean;
  echoGuardDuckFactor: number;
  bargeInEnergyThreshold: number;
  bargeInMinSpeechMs: number;
}

/** True when Medusa, rather than the provider, decides whose turn it is. */
export function ownsTurnTaking(tier: VoiceTier): boolean {
  return tier !== 'live';
}

/**
 * The `EchoGate` for this tier and these settings, or null when no gate may
 * exist. Null means `sendFrame` forwards every captured frame untouched.
 */
export function micGateFor(input: MicGateInputs): EchoGate | null {
  if (!ownsTurnTaking(input.tier)) return null;
  if (!input.echoGuardEnabled) return null;
  return new EchoGate({
    floor: floorFor(input.bargeInEnergyThreshold, input.echoGuardDuckFactor),
    minSpeechMs: input.bargeInMinSpeechMs,
  });
}

/**
 * The gain to apply to the *sent* mic signal right now. Always 1 in live tier,
 * so Gemini keeps hearing the room at full level and its VAD can find the
 * start of the user's next turn while she is still finishing her own.
 */
export function sentGainFor(
  input: Pick<MicGateInputs, 'tier' | 'echoGuardEnabled' | 'echoGuardDuckFactor'>,
  speaking: boolean,
): number {
  if (!ownsTurnTaking(input.tier)) return 1;
  if (!input.echoGuardEnabled) return 1;
  return speaking ? input.echoGuardDuckFactor : 1;
}

/**
 * Whether a barge-in noticed locally should be reported to the server as
 * `voice:interrupt`. Only the pipeline tier has a local barge-in detector to
 * report from; in live tier the provider raises its own interruption, and
 * racing it produced two interrupts for one barge-in.
 */
export function reportsLocalBargeIn(tier: VoiceTier): boolean {
  return ownsTurnTaking(tier);
}
