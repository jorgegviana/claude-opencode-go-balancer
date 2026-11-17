# Balancer

Routes agent runs between a **Claude Pro** subscription (headless `claude -p`) and an
**OpenCode Go** subscription (`opencode run`) using the usage each provider actually reports,
plus limit errors seen in finished runs. When both are limited it defers the run and resumes
after the earliest reset. Zero dependencies, Node >= 22.

## Proactive strategy

Each provider reports usage windows as percentages with a reset time:

| Provider | Windows | Source |
|----------|---------|--------|
| OpenCode Go | `rolling` (5 h), `weekly`, `monthly` | `GET https://opencode.ai/zen/go/v1/usage` |
| Claude | `five_hour`, `seven_day` (each optional) | statusline JSON, written by `bin/claude-usage-statusline.cjs` |

For every window:

```
elapsed%  = (windowLen - (resetsAt - now)) / windowLen * 100      (clamped to 0..100)
headroom  = (100 - used) - max(0, used - elapsed%)
```

Worked example: weekly window, 20% used, 50% of the week elapsed: `80 - max(0, 20 - 50) = 80`.
At 60% used with only 20% elapsed: `40 - 40 = 0`. Burning faster than the clock is penalised,
sitting under the clock is not.

A provider's headroom is the **minimum over its windows**. Then:

- **Hard stop**: any window at or above 90% makes the provider ineligible until that window resets.
- **Use it or lose it**: if the 5 h window resets within 30 minutes and is under the hard stop,
  add a +15 bonus (the quota is about to be wasted anyway).
- **Hysteresis**: when both are eligible the higher headroom wins, but the previous pick is kept
  unless the other wins by **more than 10 points** (exactly 10 keeps). This stops flapping.
- **Unknown data**: one unknown and one eligible picks the eligible one; one unknown and one
  ineligible picks the unknown one; both unknown picks `lanes.default_lane`. Claude data older
  than 15 minutes is unknown, except a stale hard-stop window still blocks until its reset.
- **Both ineligible**: verdict `wait <ISO>` (earliest reset), or `paygo` if opted in.

## Reactive signals

Run logs are scanned after each relayed run (only error-shaped events and raw stderr lines, so a
report that merely mentions "rate limit" is not a false positive). Patterns (`reactive.limit_patterns`):
`429`, `GoUsageLimitError`, `usage limit`, `rate limit`, `limit reached`.

- **Cooldown**: a limit hit puts that provider in cooldown until the `Retry-After` / `resets_at`
  hint in the log (capped at 24 h), else exponential backoff 30 s, 60 s, 120 s ... capped at 15 min.
- **Single probe**: after a cooldown expires exactly one pick is allowed through. Until it
  reports, further picks treat the provider as still limited. A success clears everything; a new
  limit during the probe re-cools with the next backoff step; a probe stuck for 15 minutes is released.
- **Circuit breaker** (opencode only, per model): 3 consecutive failures open the breaker for 30 s
  for that model (key = `opencode.agent_models[agent]`, else the agent name). After 30 s one
  half-open attempt is allowed: success closes it, failure re-opens it.

A forged limit string can only cause a bounded cooldown and a fallback to the other lane.

## Lanes and pinning (all from config)

```json
{ "lanes": { "opencode_agent_prefix": "go-", "pinned_to_claude": ["planner"],
             "balanced_agents": "*", "default_lane": "opencode" } }
```

The prefix is stripped from the agent name to get the logical name. Pinned logical names always
go to Claude. `balanced_agents` is `"*"` or a list; anything not listed goes to `default_lane`.
No agent names are hard-coded in `bin/` or `lib/`; see `examples/godotrpg/` for a real setup.

## Paygo tier (opt-in, off by default)

```json
{ "paygo": { "enabled": true, "model": "opencode/<zen-model>" } }
```

When both subscriptions are limited and this is enabled the verdict is `paygo` and the relay runs
`opencode run ... --model <model>` on pay-as-you-go. Default is to wait for the reset.

## Commands

```
node bin/balancer.cjs status                        # usage per provider, every window, last pick
node bin/balancer.cjs pick <agent>                  # line 1: opencode | claude | paygo | wait <ISO>
node bin/balancer.cjs wait-reset [--max-seconds N]  # block until a provider is usable; exit 75 on budget (default 570)
node bin/balancer.cjs record <provider> <agent> <log> [<err>]   # classify a finished run
bin/balancer-relay start <agent> <prompt-file>
bin/balancer-relay wait  <prompt-file>
```

`pick` prints the verdict on stdout line 1 and a one-line reason on stderr. Exit codes: `0` ok,
`2` usage error, `75` still waiting.

### Environment overrides

| Variable | Default |
|----------|---------|
| `BALANCER_CONFIG` | `config/balancer.config.json` (missing file = built-in defaults) |
| `BALANCER_CLAUDE_STATE` | `~/.claude/usage-state.json` |
| `BALANCER_STATE` | `~/.claude/balancer-state.json` (last pick, usage cache, cooldowns, probes, breakers; never the key) |
| `BALANCER_OPENCODE_AUTH` | `~/.local/share/opencode/auth.json` |
| `BALANCER_OPENCODE_USAGE_FILE` | read usage JSON from this file instead of the network |
| `BALANCER_NOW` | current time in ms (tests) |
| `BALANCER_OPENCODE_BIN` / `BALANCER_CLAUDE_BIN` | `opencode` / `claude` |
| `BALANCER_RELAY_WAIT_SECONDS` | `570` |

State files are written atomically (tmp + rename). Concurrent processes do last-writer-wins on
the state file, which is acceptable for cooldown bookkeeping.

## Thresholds (mirrors `config/balancer.config.json`)

| Key | Value |
|-----|-------|
| `hard_stop_percent` | 90 |
| `hysteresis_points` | 10 |
| `use_it_or_lose_it_minutes` / `_bonus` | 30 / 15 |
| `stale_minutes` (Claude data) | 15 |
| `usage_cache_seconds` | 60 |
| `fetch_timeout_ms` | 4000 |
| `wait_max_sleep_seconds` | 300 |
| `reactive.backoff_initial_seconds` / `backoff_max_seconds` | 30 / 900 |
| `reactive.hint_max_seconds` | 86400 |
| `reactive.probe_timeout_minutes` | 15 |
| `reactive.breaker_failures` / `breaker_open_seconds` | 3 / 30 |

## Claude usage: statusline setup

Claude Code only exposes its rate limits to the `statusLine` command. If you already have a
`statusLine`, **chain** it by hand (never automatic; updates of other tools may rewrite it).
Change `statusLine.command` in `~/.claude/settings.json` to:

```
node /home/jviana/git/jorgegviana/claude-opencode-go-balancer/bin/claude-usage-statusline.cjs --chain node /home/jviana/.claude/hooks/gsd-statusline.js
```

It pipes the same stdin to the chained command, prints its output, then ` | claude 5h 42% 7d 10%`.
A failing chained command still prints our text. With no existing statusLine:

```json
{ "statusLine": { "type": "command",
  "command": "node /path/to/claude-opencode-go-balancer/bin/claude-usage-statusline.cjs" } }
```

Until the statusline has run once, Claude usage is `unknown` and the balancer falls back as above.
Claude numbers are only as fresh as the last statusline refresh (they go stale after 15 minutes).

## Relay contract

`balancer-relay` keeps the contract of the original `relay.sh`: `start` returns immediately with
`started pid <n> agent=<a> provider=<p>`; `wait` blocks up to 570 s and prints `RUNNING`, or `DONE`
followed by `----- FINAL REPORT -----`, an evidence warning if the report has no verification
output, a stderr tail, `----- ORCHESTRATOR CHECK (repo state, measured by the relay) -----`
(commits since launch, `git status --short`) and the last line `relay: <provider> (log: ...)`. A
missing report prints `relay-failure: no-report` and a salvage block of the last tool commands.
After `DONE` the relay classifies the run and updates cooldown/breaker state.

Sidecar files next to the prompt: `.pid`, `.provider`, `.agent`, `.base`, `.jsonl`, `.err`.
Scratch (`TMPDIR`, caches) is redirected to `<repo>/build/`, and standing rules are appended to the run message.

If both providers are limited, `start` prints `relay: both subscriptions limited, deferred until <ISO>`
and launches a detached worker that waits for the reset, re-picks and runs the chosen provider;
`wait` reports `RUNNING` meanwhile. If the balancer throws for any reason, the relay launches plain
opencode exactly as before.

## Claude permissions

Headless Claude runs with `--permission-mode acceptEdits` and
`--allowedTools Bash(git:*) Bash(node:*) Read Write Edit`; it never gets `--agent` (a project agent
file may itself be the relay agent, which would recurse). To supply the agent's instructions set
`claude.agent_prompt_dir` (e.g. `~/.claude/agents`): `<logical agent>.md` is read, frontmatter
stripped, and passed with `--append-system-prompt`. To widen permissions, edit
`claude.allowed_tools` or `claude.permission_mode` in your config; that is an explicit choice.

## Security

- The OpenCode key is read from `auth.json` at call time into a local variable used only for the
  `Authorization` header. It is never logged, cached, stored in state or printed, and error text is
  redacted. The `User-Agent` is the generic `usage-balancer/1.0`.
- `node scripts/scan-secrets.cjs` scans tracked and untracked files for key-shaped strings and for
  the real key value, printing only `file:line rule`. Run it before every commit.
- `.gitignore` covers `auth.json`, `.env*`, state files and run logs. Tests use fixtures and an
  injected fetch; fixture keys are obviously fake.

## Caveats

- Percentages come from the providers, so no dollar caps are needed.
- The OpenCode usage endpoint is not a documented public API and may change; on any failure the
  provider is `unknown`, never an error.
- Claude window data is only as fresh as the statusline.

## Optional: RTK token savings

If [rtk](https://github.com/rtk-ai/rtk) is on your PATH, `balancer status` appends one line with its
cumulative savings (`rtk gain -f json`). It is display-only and never affects routing. If `rtk` is
missing or fails, the line is simply omitted.

Safety notes when using RTK alongside this project:
- Install the Apache-only `rtk-oss` edition from a checksum-verified release; keep telemetry off; do not enable pipelines or the proxy.
- Commands that scan raw logs for errors (for example headless Godot output) must read the raw text:
  use `rtk bypass <cmd>` or call the tool directly. The manual `rtk summary` and `rtk test` views can omit error lines.
