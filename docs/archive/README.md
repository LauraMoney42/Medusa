# Archive: the multi-bot era

The documents in this folder describe Medusa's earlier design: a roster of
always-on Claude CLI "bots," a shared **Hub** feed for bot-to-bot @mention
routing, a PM bot that assigned tasks, a poll scheduler for bot heartbeats,
dev-control (pause/resume a bot), and per-bot status symbols.

That system is being retired in favor of a single-agent, model-agnostic
design: one chat is one session with its own folder, provider, model, and
engine, and Medusa orchestrates any parallel work herself through subagents
spawned via her own MCP server. See
`docs/2026-09-17_medusa_only_orchestrator_spec.md` and
`docs/2026-09-17_ui_and_layer_addendum.md` for the current design, and
`Features.md` for the workstream roadmap (S1-S12) that carries it out.

These files are kept as project history, not as current behavior. Nothing
in this folder should be treated as an accurate description of how Medusa
works today.

## Contents

- `BOT_SYSTEM_GUIDE.md` - how the multi-bot roster worked
- `HUB_BOT_COORDINATION.md` - the Hub feed and @mention routing
- `MEDUSA_PROJECT_MANAGEMENT_GUIDE.md` - the PM-bot task-assignment workflow
- `BOT_STATUS_SYMBOLS_IMPLEMENTATION_GUIDE.md` - per-bot status icon design
- `2026-02-13_hub_feature_plan.md`, `2026-02-14_hub_auto_checkin_plan.md`,
  `2026-02-14_hub_live_comms_plan.md` - Hub feature planning docs
- `2026-02-15_bot_accountability_plan.md` - bot heartbeat/stale-assignment plan
- `bot_to_bot_api_spec.md` - the bot-to-bot messaging API
- `ios_testing_screenshot_bot_spec.md` - a standalone iOS testing bot plan
- `kanban_postit_cards_spec.md`, `kanban_strip_visibility_spec.md` - the
  bot-task Kanban strip UI
- `security_bot_instructions_draft.md` - a security-review bot's instructions
- `send_to_busy_bots_spec.md` - queuing messages to a busy bot
- `stop_all_button_spec.md` - the sidebar "Stop All" button for the bot roster
