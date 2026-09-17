# Stream fixtures

## `stream-tool-use.jsonl`

**SYNTHETIC.** This fixture was NOT captured from a live `claude` run.

A capture was attempted with:

```
claude -p "read the file package.json and tell me its name" \
  --output-format stream-json --verbose --include-partial-messages \
  --dangerously-skip-permissions
```

in a temp copy of the repo root. The CLI (v2.1.201) is installed on this machine but
the capture environment had no usable credentials, so every attempt returned
`result.result = "Not logged in · Please run /login"` with no assistant turn. Rather
than ship a fixture of an auth failure, the file was written by hand from:

- the documented event shapes on <https://code.claude.com/docs/en/headless>
  (`stream_event` wrapper, `parent_tool_use_id` on `assistant` / `user` / `stream_event`,
  `system/init` fields, `result` with `usage` and `total_cost_usd`), and
- the real lines already captured in `docs/stream-format-example.jsonl`, which the
  shapes here match field for field.

Replace it with a real capture whenever a logged-in shell is available. The parser
tests in `../stream-parser.test.ts` read this file, so a real capture with the same
turn structure can be dropped in with only the counts in those tests updated.

### What it covers

- `system/init`
- a `stream_event` text turn: `message_start`, `content_block_start` (text),
  three `text_delta`s, `content_block_stop`
- a `stream_event` tool turn: `content_block_start` (tool_use) plus two
  `input_json_delta` chunks and a `content_block_stop`
- `stream_event` `message_delta` / `message_stop`
- `assistant` messages carrying `text` and `tool_use` blocks
- `user` messages carrying `tool_result` blocks, both as a plain string and as an
  array of text blocks
- a subagent run: a `Task` tool_use, then `user` / `assistant` messages whose
  `parent_tool_use_id` is that tool call's id
- an `is_error: true` tool_result
- a final `result/success` with `usage` and `total_cost_usd`
