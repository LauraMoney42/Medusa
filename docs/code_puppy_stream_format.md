# Code Puppy as a second Medusa engine: stream-format spike

Spike date: 2026-09-15. Scope: can `code_puppy` (https://github.com/mpfaffenberger/code_puppy)
be driven headlessly by Medusa with a machine-readable event stream, the way
`server/src/claude/stream-parser.ts` drives Claude Code's
`--output-format stream-json`. No source files in this repo were modified;
all installs and captures happened in a scratch directory (paths below).

Version installed and inspected: **code-puppy 0.0.839** (PyPI, 2026-09-15).
Source also cloned from GitHub at the same tag for cross-reference.

## Install

- Supported paths: `pip`, `pipx`, or `uv` (project uses `hatchling` + a
  `uv.lock`, and ships console scripts `code-puppy` and `pup`).
- `requires-python = ">=3.11,<3.15"`. This Mac has Python 3.14.6 (Homebrew)
  as the default `python3`, `uv 0.11.8`, and `pipx 1.15.0` already present.
  Because top-level Python here is 3.14 (outside the supported ceiling), the
  install used `uv venv --python 3.13` to pin an in-range interpreter, then
  `uv pip install code-puppy` into that venv. Never installed globally.
- Install succeeded cleanly, pulling `pydantic-ai-slim[openai,anthropic,mcp]`,
  `pydantic-ai-harness`, `agent-client-protocol`, `anthropic`, `openai`,
  `boto3`, `keyring`, and friends.
- Verified: `code-puppy --version` -> `0.0.839`.

## Config and providers

- Config directory follows XDG: `$XDG_CONFIG_HOME/code_puppy/puppy.cfg`
  (default `~/.config/code_puppy/puppy.cfg`, an ini-style file), plus
  `mcp_servers.json` alongside it.
- API keys: `code_puppy/config.py::load_api_keys_to_environment()` reads a
  fixed list of env var names (falling back to `puppy.cfg` values if the env
  var is unset), in this order of precedence: `.env` file, then `puppy.cfg`,
  then process environment wins if already set. The names are:
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `CEREBRAS_API_KEY`,
  `SYN_API_KEY`, `AZURE_OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ZAI_API_KEY`,
  plus any provider-specific extra names returned by
  `provider_credentials.all_api_key_env_vars()` (custom/local providers).
- Model list: a per-user `models.json` (empty `{}` until populated; not
  shipped with real entries in the sdist/venv either) maps a model name to a
  config block with a `"type"` discriminator. `code_puppy/model_factory.py`
  handles, among others: `openai`, `anthropic`, `custom_anthropic` (Anthropic
  wire format against an arbitrary `base_url`, i.e. Anthropic-compatible
  endpoints are supported), `custom_openai_responses`, `gemini`,
  `custom_gemini`, `azure_openai`, `azure_foundry_openai`, `cerebras`,
  `zai_coding`, `zai_api`, `openrouter` (uses
  `pydantic_ai.providers.openrouter.OpenRouterProvider` and reads
  `OPENROUTER_API_KEY`), `round_robin`, `claude_code`/`claude-code-*`
  (shells out to a local Claude Code install), and `copilot`. So: yes to
  OpenRouter, yes to Anthropic-compatible custom endpoints via
  `custom_anthropic` + `custom_endpoint.url`.
- Selection: `--model NAME` / `-m NAME` on the CLI, or `model` in
  `puppy.cfg`, or `/model` inside the TUI. `--agent NAME` / `-a NAME` picks
  a named agent persona (agents live under `code_puppy/agents/`).
- First-run gap: `ensure_config_exists()` requires two keys,
  `puppy_name` and `owner_name` (`REQUIRED_KEYS` in `config.py`), and if
  either is missing it calls Python's blocking `input()` **even when invoked
  with `-p`**, i.e. even in "headless" mode. There is no CLI flag or env var
  to pre-answer this; the only way to avoid the prompt in an
  automated/no-TTY launch is to pre-write a `puppy.cfg` containing those two
  keys before the first spawn. Confirmed live below.

## Headless / CLI surface (exact flags, from `code-puppy --help`, v0.0.839)

```
usage: code-puppy [-h] [--version] [--interactive] [--prompt PROMPT]
                  [--disable-ask-user-question] [--usage-file PATH]
                  [--agent AGENT] [--model MODEL] [--resume PATH] [--cwd]
                  [--quick-resume [PATH]] [--port-base PORT] [--acp]
                  [--no-tools] [--profile NAME] [--yolo {true,false}]
                  [command ...]

--prompt, -p PROMPT   Execute a single prompt and exit (no interactive mode)
--usage-file PATH     Write aggregate headless model usage as JSON (one
                       summary object written at the end, not a stream)
--agent, -a AGENT     Specify which agent to use
--model, -m MODEL     Specify which model to use
--resume, -r PATH     Resume a saved session (.json envelope; legacy .pkl
                       migrates automatically)
--cwd                 Scope --resume session listing to the current dir
--quick-resume, -qr [PATH]  Resume the most recent session for PATH
--port-base PORT      Local HTTP server port range start (not relevant here)
--acp                 Run as a native agent over the Agent Client Protocol
                       (ACP), speaking JSON-RPC over stdio.
--no-tools            Disable all agent tools and MCP servers (pure text
                       in/out; == CODE_PUPPY_NO_TOOLS=1)
--profile NAME        Named configuration profile for this run
--yolo {true,false}   Override YOLO (auto-approve) mode for this run
```

Key findings, cross-checked against `code_puppy/cli_runner.py`:

- **Single-prompt / non-interactive mode**: yes, `-p "..."`. It is the
  equivalent of `claude -p`.
- **JSON/NDJSON output for `-p`**: **no**. `-p` renders through the same
  Rich-console `MessageBus`/`emit_*` machinery as the interactive TUI
  (colorized text, banners, spinners): plain human-readable text on
  stdout, not structured events. `--usage-file` only writes one final JSON
  object (token/cost totals) after the run completes, not a per-event
  stream. Confirmed live: see `headless_p_stdout.log` below.
- **A genuine machine-readable streaming mode does exist, but it's a
  different flag**: `--acp`, which runs Code Puppy as an **Agent Client
  Protocol (ACP)** server: JSON-RPC 2.0, one message per line over
  stdin/stdout (the same protocol Zed uses to host Gemini CLI and Claude
  Code as embedded agents). This is implemented by the
  `code_puppy_core_plugins.acp` module (bundled as a hard dependency,
  `code-puppy-core-plugins`), built on the official `agent-client-protocol`
  PyPI SDK (`acp.run_agent`). `--acp` short-circuits the TUI entirely, and
  the plugin explicitly redirects the console/logger to **stderr** so stdout
  stays pure JSON-RPC ("stdout is sacred").
- **Session resume**: yes, both for `-p`/interactive (`--resume`,
  `--quick-resume`, autosaved envelopes under XDG data dir) and, separately,
  natively inside the ACP protocol (`session/load`, `session/resume`,
  `session/fork`, `session/list`, `session/close`), persisted as pickled
  history plus a JSON metadata sidecar per session id.
- **Yolo / auto-approve**: yes, `--yolo {true,false}` (also `/set
  yolo_mode` in-session, and a `puppy.cfg` key) governs whether file-write
  and shell-command tool calls need approval. Over ACP specifically, the
  plugin's README states permissions are **never force-yolo'd**: approvals
  always round-trip to the client via `session/request_permission`, even if
  local `--yolo true` is set for the process (the client is treated as the
  authority in that mode). For non-ACP CLI/TUI headless (`-p`) runs, `--yolo
  true` does control local auto-approval, and is the flag Medusa would need
  to avoid an interactive approval prompt that a background process can
  never answer.
- **System prompt injection**: not a public CLI flag; headless (`-p`) runs
  append a fixed internal string (`_HEADLESS_AUTONOMY_PROMPT` in
  `cli_runner.py`) via `agent.temporary_system_prompt_addition(...)`, and
  the general per-agent persona/system prompt is defined by agent
  definition files under `code_puppy/agents/`, not passed as an ad hoc CLI
  arg. No `--append-system-prompt`-equivalent was found.
- **Working directory flag**: no generic `--cwd DIR` to set the working
  root for a `-p` run (the `--cwd` flag that exists only filters
  `--resume` session listing); a `-p`/CLI run works out of the process's
  actual OS `cwd`, so Medusa would `cwd:` the spawned child process itself
  (same approach it already uses for Claude Code). Over ACP, `cwd` is an
  explicit, first-class parameter of `session/new`.
- **Abort behavior on SIGTERM**: no explicit `SIGTERM` handler was found
  anywhere in `cli_runner.py` or the ACP plugin; only `SIGINT` (Ctrl+C) is
  intercepted, and Python's default `SIGTERM` behavior (immediate process
  termination, no cleanup, no "graceful stop" event) applies. `session/cancel`
  over ACP is a much better story for Medusa: it cancels the in-flight
  `asyncio.Task` and also kills any local shells the agent started, then
  emits a clean JSON-RPC response, but that's a protocol-level cancel
  message, not a process signal.

## Captured samples

Everything below is a **live capture** on this machine, no API key needed
for these particular calls (the process failed only once it needed to
actually call a model). No `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`OPENROUTER_API_KEY` was present in this environment (only an unrelated
`ANTHROPIC_BASE_URL` used by Claude Code itself was set); this spike did not
attempt to source or fabricate one, per instructions.

- Full raw JSON-RPC transcript (request lines + response/notification lines
  interleaved, one per line):
  `<scratchpad>/codepuppy/codepuppy_acp_live_capture.jsonl` (8 lines)
- Headless `-p` plain-text stdout/stderr (shows the first-run wizard
  blocking on `input()` even under `-p`, and the traceback that follows
  once stdin hits EOF non-interactively):
  `<scratchpad>/codepuppy/headless_p_stdout.log`

`<scratchpad>` = this session's scratch directory,
`.../scratchpad/codepuppy/`.

Representative lines from the ACP capture (`initialize` -> `session/new` ->
`session/prompt`, run against `code-puppy --acp` with empty XDG dirs and no
model configured, so the prompt fails at model-load time rather than never
producing a machine-readable event at all):

```json
{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": true, "writeTextFile": true}, "terminal": true}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"sessionCapabilities":{"list":{},"additionalDirectories":{},"fork":{},"resume":{},"close":{}}},"agentInfo":{"name":"code-puppy","title":"Code Puppy","version":"0.0.839"}}}
{"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/private/tmp/.../scratchpad/codepuppy/work", "mcpServers": []}}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess_1066943ae521414e","configOptions":[{"currentValue":"default","options":[{"value":"default","name":"Default","description":"Standard Code Puppy session"}],"id":"mode","name":"Mode","category":"mode","type":"select"},{"currentValue":"on","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}],"id":"enable_streaming","name":"Streaming responses","description":"Stream model output token-by-token.","type":"select"}]}}
{"jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": {"sessionId": "sess_1066943ae521414e", "prompt": [{"type": "text", "text": "create hello.txt containing hi"}]}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1066943ae521414e","update":{"content":{"text":"⚠️ The agent run failed: No valid model could be loaded. Update the model configuration or set a valid model with `config set`.","type":"text"},"sessionUpdate":"agent_message_chunk"}}}
{"jsonrpc":"2.0","id":3,"result":{"stopReason":"refusal"}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess_1066943ae521414e","update":{"availableCommands":[{"name":"wiggum","description":"Loop mode: re-run the same prompt when agent finishes"},{"name":"goal","description":"Retry a task until all LLM judges say it is complete"},{"name":"wiggum_stop","description":"Stop Wiggum/goal loop mode"},{"name":"judges","description":"Configure goal-mode LLM judges (TUI)"}],"sessionUpdate":"available_commands_update"}}}
```

Observations from this live sample, plus the (not-live, source-read)
protocol shapes documented in the plugin's own README
(`code_puppy_core_plugins/acp/README.md`, installed alongside the package):

- Framing is one JSON object per line (NDJSON-style), matching how Medusa's
  `stream-parser.ts` already reads Claude Code's stream: readable with the
  same line-buffered `readline`/split-on-`\n` approach.
- The `initialize` response has no `session_id`, no `model`, no `tools`
  list, unlike Claude Code's `system`/`init` line. Session id only appears
  once `session/new` responds.
- Assistant text streams as `session/update` notifications with
  `update.sessionUpdate == "agent_message_chunk"` and `update.content.text`
  carrying incremental text (per source: `agent_thought_chunk` for
  reasoning/thinking deltas, mapped from pydantic-ai's `TextPartDelta` /
  `ThinkingPartDelta`, not captured live here because the run failed before
  any model call streamed text).
- Tool calls stream as `tool_call` (status `in_progress`) then
  `tool_call_update` (status `completed`/`failed`), each carrying a `kind`,
  file `locations`, a human title (e.g. "Edit foo.py", "Run: pytest"), and
  on completion a unified diff as an inline content block, per source
  (`bridge.py`); not captured live since no tool call ran here.
- The **final response to `session/prompt`** (an actual JSON-RPC response,
  correlated by `id`, not a notification) carries `stopReason` (e.g.
  `"end_turn"`, `"refusal"`, `"cancelled"` per source) and, on success,
  **token usage** for that turn (per the plugin README: "Prompt turns
  report token usage"); it was `"refusal"` here because the run errored
  before producing output.
- Errors that happen *inside* a model/tool run (as opposed to a malformed
  JSON-RPC call) are not surfaced as a JSON-RPC `error` object; they come
  back as an ordinary `agent_message_chunk` with the error text baked into
  the message, followed by a normal-shaped result envelope
  (`stopReason: "refusal"`). Medusa would need to detect these by content
  (e.g. a leading warning glyph and "agent run failed") rather than by a
  dedicated `type: "error"` event the way Claude Code emits `result`/
  `subtype: "error"`.
- `session_id` format is `sess_<16 hex chars>`, generated per `session/new`
  call, not tied to a model/provider.

## Event mapping table

Mapping Code Puppy's ACP `session/update` kinds (the only structured stream
that exists) to Medusa's `ClaudeStreamEvent`/`ParsedEvent` model in
`server/src/claude/types.ts`:

| Medusa concept (`server/src/claude/types.ts`) | Code Puppy ACP equivalent | Notes |
|---|---|---|
| `SystemInit` (`type: "system"`, `subtype: "init"`, `session_id`, `cwd`, `model`, `tools`) | Split across two calls: `initialize` response (`agentCapabilities`, no ids) + `session/new` response (`sessionId`, `configOptions`, no `cwd`/`model`/`tools` echoed back) | No single init event; Medusa would synthesize its own `ParsedInit` from the `session/new` request params (`cwd`) it sent plus the currently configured model, since the server doesn't echo them. |
| `ContentBlockDelta` w/ `TextDelta` -> `ParsedDelta` | `session/update`, `update.sessionUpdate == "agent_message_chunk"`, text in `update.content.text` | Confirmed live above. Same incremental-text semantics. |
| (no direct Claude equivalent; extended thinking is a separate content block in Claude's format) | `session/update`, `sessionUpdate == "agent_thought_chunk"` | Not captured live (no model ran); documented in source/README. Medusa's parser has no thinking-delta case today; would need a new `ParsedEvent` kind or drop it. |
| `ContentBlockStart`/`Delta` w/ `ContentBlockToolUse` -> `ParsedToolUseStart` | `session/update`, `sessionUpdate == "tool_call"` (status `in_progress`), `tool_call_update` (status `completed`/`failed`) | Two-notification lifecycle instead of Claude's start/delta/stop triple; carries `kind`, `locations`, a title, and a diff instead of raw JSON args. Field-level remap needed. |
| `ContentBlockToolResult` -> `ParsedToolResult` | Folded into the same `tool_call_update` (`status: "completed"`, with diff/result content) rather than a separate result block | No standalone tool_result message; Medusa's tool-result parsing would need to read the terminal state of a `tool_call_update` instead. |
| `AssistantMessage` -> `ParsedAssistantComplete` | No exact analogue; the accumulated text is implicit (client is expected to concatenate `agent_message_chunk`s) | Medusa would need to buffer chunks itself to reconstruct a "final assistant message," the same way many ACP clients do. |
| `ResultSuccess`/`ResultError` -> `ParsedResult` | The JSON-RPC **response** to the original `session/prompt` request (`id`-correlated), `result.stopReason` (`end_turn`/`refusal`/`cancelled`/etc.), plus (per README) turn-level token usage on success | Usable, but structurally different: it's a request/response pair, not a standalone line in the stream; Medusa's line-oriented parser would need to correlate by `id` instead of reading every line uniformly. |
| `UsageInfo` (`input_tokens`, `output_tokens`, cache fields) -> cost/usage in `ParsedResult` | Turn-level usage in the `session/prompt` result (fields/shape not enumerated in the README; not observed live here since the run errored before usage was computed); separately, `--usage-file` (CLI-only, not ACP) writes one cumulative JSON object at process exit | No cache-token breakdown documented; no cost-in-USD figure anywhere in the ACP or CLI surface (Code Puppy has no built-in `$` cost, only token counts and whatever the caller computes from them). |
| `ParsedError` | Ad hoc: an `agent_message_chunk` whose text contains an error message, or a `session/update` for `available_commands_update` unrelated to errors | No dedicated error-event type; also, malformed/protocol-level JSON-RPC errors (bad method, bad params) do use standard JSON-RPC `error` objects per the SDK, but *in-run* failures (bad model, model API error) do not, as captured live above. |

## Gaps

1. **No JSON/NDJSON mode on the simple `-p` path.** The only structured,
   parseable stream is behind `--acp`, a materially different protocol
   (bidirectional JSON-RPC, not a flat one-way event log) built for
   editor-hosted agent panels, not for a backend spawning a fire-and-forget
   CLI job the way Medusa spawns Claude Code today.
2. **No session/model/cwd/tools echoed in one place.** Claude Code's single
   `system`/`init` line gives Medusa session id + model + cwd + tool list
   up front; ACP splits/omits this (see table above), and `-p` prints none
   of it machine-readably at all.
3. **No cost figures.** Neither surface reports a dollar cost; only token
   counts (ACP, per-turn, shape unconfirmed since a live successful run
   with a real key was not possible here) or a cumulative post-hoc JSON
   file (`--usage-file`, CLI only, not per-turn, not streamed).
4. **No dedicated error event type**; in-run failures are just chat text,
   which is fragile to detect programmatically (string/emoji sniffing).
5. **First-run interactive wizard blocks even `-p`** unless `puppy.cfg`
   is pre-seeded with `puppy_name`/`owner_name`, a real headless-deploy
   trap, confirmed live in this spike.
6. **No SIGTERM handling** in the plain CLI/ACP process; a supervised
   child process killed with SIGTERM gets no graceful-shutdown chance
   (ACP's own `session/cancel` is graceful, but that's a protocol call
   Medusa's process-level shutdown code doesn't naturally reach for).
7. **This spike could not exercise a real, successful run** (no
   `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` present in
   this environment), so the exact shape of a successful `tool_call`,
   `tool_call_update` (with diff), `agent_thought_chunk`, and the
   `session/prompt` success-path usage payload are documented from source
   and the plugin's own README, not confirmed byte-for-byte live.

### Smallest upstream change that would help

If integrating via `--acp` is judged too heavy (bidirectional protocol,
client must serve `fs/*`/`terminal/*` callbacks and a permission dialog),
the smallest useful upstream PR to `mpfaffenberger/code_puppy` would be a
new flag alongside `-p`, e.g. `--output-format ndjson`, that taps the exact
same internal seam the ACP plugin already uses (`stream_event`,
`pre_tool_call`, `post_tool_call` hooks documented in
`code_puppy_core_plugins/acp/README.md`) and prints each event as one JSON
line on stdout instead of routing it through the Rich console, reusing the
ACP bridge's event-to-JSON mapping logic but emitting a flat one-way stream
(no request/response correlation, no client-callback obligations) which is
exactly the shape `server/src/claude/stream-parser.ts` already expects.
That is a small, additive change (an alternate renderer for an existing,
already-decoupled event source) rather than a new protocol implementation.

## Recommendation: GO-WITH-UPSTREAM-PR

Code Puppy is a real, actively maintained multi-provider agent with
first-class support for OpenRouter and Anthropic-compatible endpoints
(matching Medusa's provider needs), and it does have a genuine
machine-readable, streaming interface: `--acp` (Agent Client Protocol,
JSON-RPC over stdio), confirmed live on this Mac against a real subprocess.
But `--acp` is not a drop-in replacement for the `stream-json` NDJSON
contract Medusa's parser understands: it's bidirectional (Medusa would need
to implement client-side `fs/*`, `terminal/*`, and permission-dialog
callbacks, or accept `--yolo` is ignored for approvals over ACP), it
correlates events by JSON-RPC request/response rather than a flat line
stream, and several fields Medusa's parser relies on today (upfront model,
cost) are missing or reshaped. Combined with the first-run interactive
wizard trap and the missing SIGTERM handling, plugging Code Puppy straight
into the existing `stream-parser.ts` is not a small job as-is.

The pragmatic path is: land a small upstream flag (`--output-format
ndjson`, sketched above) that reuses Code Puppy's existing internal event
hooks to emit the same flat one-way NDJSON shape Medusa already parses,
rather than either (a) building a full ACP client inside Medusa or (b)
giving up on structured Code Puppy output entirely. Until that lands,
integration should stay a spike/prototype behind a feature flag, not a
production second engine.
