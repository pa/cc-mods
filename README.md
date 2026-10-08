# cc-mods

Mods for Claude Code: bands, panes and hooks that add small things to the terminal. Install any of them with `/plugin install`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install <mod> --marketplace pa/cc-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads the mod in every session). The mod is active as soon as it installs. After the first mod, later installs skip the marketplace question.

To update, run `/plugin`, open the `cc-mods` marketplace and update.

## Mods

| Mod | What it does | Needs |
| --- | --- | --- |
| [flow-band](./flow-band) | A band above the prompt with the session's bound [flow](https://github.com/Facets-cloud/flow) task and inbox count. `/fs` or ctrl+f opens a switcher over in-progress tasks; Enter runs `flow do` on the pick. | `flow` and `sqlite3` on `PATH`, an initialised `~/.flow` |

flow-band reads the session binding from `~/.flow/flow.db` with `sqlite3 -readonly` until `flow show task` gets JSON output. It never writes to the database.

## Developing a mod

Each mod is a folder with `.claude-plugin/plugin.json` and `hooks/`. Run one from its folder without installing:

```
claude --plugin-dir ./flow-band
```

Check and test before committing:

```
claude plugin validate ./flow-band
claude plugin test ./flow-band
```

To add a mod, create its folder and add an entry to `plugins` in `.claude-plugin/marketplace.json`.
