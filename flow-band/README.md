# flow-band

A band above the Claude Code prompt that shows which [flow](https://github.com/Facets-cloud/flow) task this session is bound to, plus how many flow inbox messages are waiting for you. It also has a switcher that jumps to any in-progress task's session without leaving the one you're in.

## What it looks like

The band, collapsed, in a session bound to `platform/auth-token-rotation` with three messages waiting:

```
flow ▸ ● platform/auth-token-rotation                                                       ✉ 3 Switch Hide ⌃X ⇥
```

An unbound session shows `▸ not bound` instead of the task.

The switcher, opened with ctrl+x tab, Switch or `/fs`:

```
╭────────────────────────────────────────────────────────────────────────────────────────────────────────────╮ [-]
│ › Search in-progress tasks… ⏎ open                                                         14 ⇅ priority × │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
  PRI TASK                              STATE     NAME                                                    TAGS
↵ H   platform/auth-token-rotation        ◉       Rotate signing keys with a grace window      #auth #security
  H   data-pipeline/backfill-events       ◉ ◔     Backfill March events after the schema fix              #etl
  H   billing/invoice-retry                   ⚠   Retry failed invoice webhooks with backoff         #payments
  H   ops/oncall-runbook                        ◆ Refresh the on-call runbook before the swap          #oncall
  M   docs/api-reference                      ⚠   Regenerate API docs from the OpenAPI spec              #docs
  M   mobile-app/offline-sync                     Offline sync for drafts on Android                  #android
  M   platform/rate-limits                  ◔     Per-tenant rate limits on the public API                #api
  M   ops/weekly-sync--2026-10-07-09-00 ▶         Weekly sync notes
  ↓ 6 more
 ↵ open top · ↓↑ move · × close · esc prompt
 PRI H high · M medium · L low   STATE ▶ run · ◉ live · ◔ waiting · ⚠ stale · ◆ due
```

In the terminal the glyphs are colored the way flow colors them: ◉ cyan, ◔ yellow, ⚠ red, ◆ red when overdue and yellow when due within three days.

## Using it

| Do this | To |
| --- | --- |
| ctrl+x tab, Switch, or `/fs` | open the switcher |
| `×` | close it (Esc only hands the keys back to the prompt) |
| type | filter by slug, name, project or tag |
| Enter | open the top row |
| ↓ ↑, or click a task | pick a row and open it |
| `⇅ priority` | toggle between priority order and most recently updated |
| `/fs <search>` | open the first match straight away, no switcher |
| Hide | hide the band for this session |

The list holds in-progress tasks and playbook runs. Opening a task runs `flow do <slug>`, which opens or focuses that task's own session. The session you're in doesn't change. When the other session binds, it shows a toast saying it was opened from the switcher. The model there never sees that message.

The band refreshes at session start and after every turn.

ctrl+x tab is Claude Code's default chord for focusing the band. A plugin can't ship key bindings, so for a one-key toggle add ctrl+f to your own `~/.claude/keybindings.json`. It opens the switcher from the prompt and closes it from the search box:

```json
{ "context": "Chat", "bindings": { "ctrl+f": "abovePrompt:focus" } },
{ "context": "AbovePromptInput", "bindings": { "ctrl+f": "abovePrompt:previous" } }
```

## Requirements

- `flow` on `PATH`, with `~/.flow` set up (`flow init`)
- `sqlite3` on `PATH`

flow-band reads this session's binding from `~/.flow/flow.db` with `sqlite3 -readonly`, because `flow show task` has no JSON output yet. Everything else goes through the `flow` CLI. It never writes to the database.

## Install

```
/plugin install flow-band --marketplace pa/cc-mods
```
