/**
 * Kimi in warm mode (S16).
 *
 * `kimi --print` (what `kimi-cli-engine.ts` drives) pays the Python
 * interpreter start-up, the config load and the model handshake on every
 * single turn, and it only writes its stdout when the turn is already over, so
 * "time to first token" is really "time to whole answer". Measured on this
 * machine against kimi-cli 1.47.0: about 3.2 to 4.7 s before the first byte of
 * a one-word answer.
 *
 * `kimi acp` is the same agent behind the Agent Client Protocol, which Medusa
 * already speaks (`acp-engine.ts`), and it streams `agent_message_chunk`
 * notifications as the model writes. With `persistent: true` the process and
 * its ACP session survive between turns, so the start-up cost is paid once per
 * chat: the same probe measured about 2.0 s to the first streamed token on
 * turns 2 and 3, against 3.7 s on the first (handshake included).
 *
 * The cold engine stays registered and stays the default; this one is selected
 * only when warm mode is on for the session (see ProcessManager.setWarmMode).
 */

import { AcpEngine } from "./acp-engine.js";
import type { ModelInfo } from "./types.js";

/** Engine id for the warm variant. Kept distinct so abort/teardown match. */
export const KIMI_WARM_ENGINE_ID = "kimi-warm";

export const KIMI_MODELS: ModelInfo[] = [
  { id: "kimi-for-coding", label: "Kimi for Coding" },
];

export function createKimiAcpEngine(): AcpEngine {
  return new AcpEngine({
    id: KIMI_WARM_ENGINE_ID,
    displayName: "Kimi CLI (warm)",
    command: "kimi",
    // `kimi --acp` is deprecated in 1.47 in favour of the `acp` subcommand.
    args: ["acp"],
    models: KIMI_MODELS,
    persistent: true,
  });
}
