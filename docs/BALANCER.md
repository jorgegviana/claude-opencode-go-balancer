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

- **Hard stop**: any window at or above the provider's hard stop makes it ineligible until that
  window resets. The hard stop is `hard_stop_percent` (90) minus `reserve_percent.<provider>`:
  OpenCode stops at 90%, Claude at **80%**. The Claude reserve exists because the interactive
  session that orchestrates the workers draws on the same Claude quota; without it the workers can
  starve their own orchestrator. Set `reserve_percent.claude` to 0 for the old behaviour.
- **In-flight runs**: a run that was picked but has not finished yet counts against its provider
  (`inflight.cost_points`, 2 points of a 5 h window per run, scaled down for longer windows, or the
  learned cost once known). A burst of `start` calls therefore spreads instead of all seeing the same
  usage snapshot. The relay ties the entry to the provider's process, so it lasts exactly as long
  as the run; an entry that was never launched expires after `inflight.ttl_minutes` (30).
- **Use it or lose it**: if the 5 h window resets within 30 minutes, is under the hard stop **and
  is the window that limits the provider**, add a +15 bonus (the quota is about to be wasted
  anyway). When a longer window is the binding one there is no bonus: weekly quota is not about to
  be lost.
- **Hysteresis**: when both are eligible the higher headroom wins, but the previous pick is kept
  unless the other wins by **more than 10 points** (exactly 10 keeps). This stops flapping.
- **Runs left**: 10% of a Claude window and 10% of a Go window are different amounts of work. When
  a relayed run finishes, the relay reads the **tokens the run used from its own log** and compares
  the usage at pick time with the usage now. From both it learns, per provider and window, the
  percent points one token costs (decayed sums, so the whole-percent rounding of single runs
  averages out; concurrent runs share the increase), and per agent the tokens a run typically uses.
  The cost of the next run is the product of the two. Once both providers have
  `strategy.min_samples` (10) measured runs and a window that has visibly moved, the comparison
  switches from percent headroom to **estimated runs left before the hard stop**, with
  `strategy.hysteresis_runs` (2) as the margin. A window that never moved is not used for the
  estimate. `status` and `stats` show it. It is still an estimate: your own interactive Claude use
  lands in the Claude number too. Set `strategy.runs_remaining` to false to stay on percent.
- The reserve is subtracted from headroom as well, so a provider's headroom reaches the comparison
  as usable quota only.
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

- **MODEL_GONE**: log errors matching `reactive.model_gone_patterns` (`model not found`,
  `model_not_found`, `HTTP 404` / `statusCode 404`, `model ... does not exist` and `model ... retired`
  on one line) are checked before the limit patterns, for opencode and free runs only: a Claude run
  never selects an opencode model, so the same text in a Claude log is an ordinary failure. A bare
  `404` or the word `retired` without that context does not match. The model (key = `opencode.agent_models[agent]`, else the agent name; the
  model id for the free lane) gets a per-model cooldown of `reactive.model_gone_cooldown_seconds`
  (3600). It never counts against the provider and never advances the circuit breaker. While the
  cooldown lasts the opencode lane is ineligible for that agent only.

A forged limit or model-gone string can only cause a bounded cooldown (at most 1 h for one model)
and a fallback to another lane.

## Lanes and pinning (all from config)

```json
{ "lanes": { "opencode_agent_prefix": "go-", "pinned_to_claude": ["planner"],
             "balanced_agents": "*", "default_lane": "opencode" } }
```

The prefix is stripped from the agent name to get the logical name. Pinned logical names always
go to Claude. `balanced_agents` is `"*"` or a list; anything not listed goes to `default_lane`.

**Preferences (soft pin).** `lanes.preferences` maps a logical agent to an ordered provider list:

```json
{ "lanes": { "preferences": { "architect": ["claude", "opencode"], "formatter": ["opencode"] } } }
```

The first listed provider that is not limited wins; if all listed ones are limited the normal
decision applies (the other provider, `wait` or `paygo`). Unlike `pinned_to_claude` it falls back,
and it does not move `lastPick`. Use `balancer stats` (success rate per agent and provider) to
decide which agents deserve a preference.

**Escalation.** When an opencode or Claude run ends **without a report** and its outcome is listed
in `lanes.escalate_on` (default `["limit", "model_gone"]`), the relay re-runs the same prompt once
on the other subscription and keeps waiting. Add `"failure"` to also re-run crashes and timeouts;
set `[]` to turn it off. Pinned agents, non-balanced agents and the case where the other provider
is limited too are never escalated. The re-run is told that an earlier attempt may have left
partial changes in the working tree and to inspect them first. The first run's logs are kept as `.opencode.jsonl` /
`.claude.jsonl` (and `.err`), and the output contains
`relay: escalated from <provider> (<agent or model>: <outcome>) to <provider>`.
No agent names are hard-coded in `bin/` or `lib/`; see `examples/godotrpg/` for a real setup.

## Using it for any task

Nothing in `bin/` or `lib/` knows about a particular agent framework; GSD names appear only in
`examples/godotrpg/`. For an arbitrary task you need:

- **A prompt file** that states the task and asks for a final report. The relay treats the last
  text of the run as the report.
- **An agent name.** On the opencode lane it is passed as `opencode run --agent <name>`, so it must
  be an agent opencode knows (`opencode agent list`; `build` always exists). On the Claude lane the
  name is not passed: Claude runs with the default system prompt unless `claude.agent_prompt_dir`
  holds `<logical name>.md`. The `go-` prefix is only a naming convention
  (`lanes.opencode_agent_prefix`, may be empty).
- **A git repository as working directory** for the repo-state check; without one the relay still
  runs and reports `commits since launch: unknown`.

Two things are opinionated and apply to every task: the standing rules appended to the prompt
(stay inside the project root, scratch files in `build/tmp`, no `git stash`, a complete final
report), and the Claude lane's tool allow-list, which only permits `git status/diff/log/add/commit`,
`node --test` and `npm test` as shell commands. A task that needs other commands on the Claude
lane (a Python project's test runner, say) needs `claude.allowed_tools` extended, or it will only
work on the opencode lane.

## Paygo tier (opt-in, off by default)

```json
{ "paygo": { "enabled": true, "model": "opencode/<zen-model>" } }
```

When both subscriptions are limited and this is enabled the verdict is `paygo` and the relay runs
`opencode run ... --model <model>` on pay-as-you-go. Default is to wait for the reset.

`paygo.max_runs_per_day` (default 10, `null` = unlimited) caps paygo picks in any rolling 24 hours;
over the cap the verdict is `wait`. There is no balance API for this tier, so the cap counts runs,
not dollars. A paygo run is recorded as `paygo` (last line `relay: paygo (log: ...)`): its success
or failure never changes the Go subscription's cooldown, probe or circuit breaker.

## Free lane (opt-in, off by default)

An optional lane that runs explicitly listed agents on free OpenCode Zen models without touching
Go or Claude quota. With no `free_lane` key (or `enabled: false`) behavior is identical to before.

```json
{ "free_lane": {
    "enabled": false,
    "models": ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free",
               "opencode/mimo-v2.6-flash-free", "opencode/minimax-m3.1-flash-free",
               "opencode/longcat-2.5-free", "opencode/hy4-flash-free", "opencode/big-pickle"],
    "agents": [],
    "canary_ttl_days": 7,
    "canary_timeout_seconds": 300,
    "escalate_on_failure": true } }
```

**Privacy warning.** Some OpenCode Zen free models may log, retain or train on the prompts and
outputs sent to them. Only list agents whose prompts and repository content you are willing to
share. The default `agents` list is empty, and agents in `lanes.pinned_to_claude` never go free.

`pick <agent>` prints `free opencode/<id>` (line 1) only when all of these hold: `free_lane.enabled`,
the logical agent is in `free_lane.agents`, the agent is not pinned to Claude, and a model in
`free_lane.models` (tried in order) has a passing canary newer than `canary_ttl_days`, is not in a
per-model cooldown, has a closed circuit breaker (keyed by the full model id), and is not missing from
a successfully read catalog, nor marked `deprecated` or without tool calling there
(`free_lane.require_toolcall`). With `free_lane.rotate: true` the ready model used longest ago is
taken instead of the first in config order. With `free_lane.discover: true` every free, active,
tool-capable model in the catalogs of `free_lane.discover_providers` (default `opencode`) is a
candidate after the configured ones, so the list does not go stale as models come and go; each
still needs a passing canary, and `balancer canary` with no arguments covers them (run
`balancer models --refresh` first, and schedule both, e.g. weekly from cron, to keep it current). A successful real run renews the model's canary
(`free_lane.renew_canary_on_success`), so a lane in regular use does not expire after 7 days. Otherwise `pick` continues exactly as before. The free decision never
reads Go or Claude usage and does not change `lastPick`.

**Relay.** For a `free` verdict `balancer-relay` runs `opencode run ... --agent <agent> --model
opencode/<id>` with the same standing rules, and with an environment stripped of variables whose
name matches `relay.env_scrub_patterns` (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
`CREDENTIAL`; list exceptions in `relay.env_keep`, or set `relay.scrub_env_free: false`). Provider
keys belong in opencode's `auth.json`, not in the environment. `start` prints
`started pid N agent=<a> provider=free model=<model>`; the last `wait` line is `relay: free (log: ...)`.
A free run is recorded against the model only (cooldown, breaker), never against the opencode provider.

**Single escalation.** If a free run ends without a report and `escalate_on_failure` is true, the
relay records the failure on the model, re-picks once with the free lane excluded, launches that run
and keeps waiting. The final `DONE` output then contains
`relay: escalated from free (<model>: <outcome>) to <provider>` just before the last line. It happens
at most once per prompt. Extra sidecars: `.model` (the free model), `.escalated` (marker, also blocks a
second escalation), `.free.jsonl` / `.free.err` (the failed free run's logs).

**Enable.** `node bin/balancer.cjs canary` (runs a `hello.txt` task per model in a fresh empty temp dir
outside any repo, no project data, no attached files; pass only if the file contains exactly `ok`;
`--timeout N` overrides, model names can be given as arguments), check `node bin/balancer.cjs status`,
then set `free_lane.enabled: true` and add agent names to `free_lane.agents`.
**Rollback.** Set `enabled: false`, or remove the agent from `agents`.

## Model catalog

`opencode models <provider> --verbose` is read per provider prefix (`opencode`, `opencode-go`), cached in
the state file for `catalog.ttl_seconds` (600) and always fails open: a timeout, error or unparseable
output (cached for the TTL too) never excludes a model. A model is "missing" only if the catalog of its
own provider was read successfully and lacks it. It is used for free models and for the opencode lane:
when `opencode.agent_models[agent]` is missing the lane is ineligible for that agent until the cache
entry expires (`catalog.check_agent_models`). Default configs with no `agent_models` and no free lane never
run `opencode`. `node bin/balancer.cjs models [--refresh]` lists configured models missing from the
catalog (with where they are configured) and free (cost 0) catalog models that are not configured; it
exits 1 if a catalog is unavailable. `status` shows the free lane and cached catalog freshness only.

## Commands

```
node bin/balancer.cjs status                        # usage per provider, every window, last pick
node bin/balancer.cjs pick <agent> [--dry-run]      # line 1: opencode | claude | paygo | free <model> | wait <ISO>
node bin/balancer.cjs stats                         # outcomes per provider and agent, learned usage per run
node bin/balancer.cjs wait-reset [--max-seconds N]  # block until a provider is usable; exit 75 on budget (default 570)
node bin/balancer.cjs record <provider> <agent> <log> [<err>]   # classify a finished run
node bin/balancer.cjs canary [model...] [--timeout N]           # free-model canary; exit 1 if any fails
node bin/balancer.cjs models [--refresh]                        # catalog vs configured models
bin/balancer-relay start <agent> <prompt-file>
bin/balancer-relay wait  <prompt-file>
bin/balancer-relay cancel <prompt-file>             # stop a running or deferred run; nothing is counted
bin/balancer-relay verdict <prompt-file> accept|reject   # tell the log whether the result was used
```

`pick` prints the verdict on stdout line 1 and a one-line reason on stderr. Exit codes: `0` ok,
`1` error (including an invalid config), `2` usage error, `75` still waiting.

`pick` is not read-only: it claims the single probe, counts the run as in flight and (for paygo)
against the daily cap, because the caller is expected to launch it. Use `--dry-run` to only look.

**Config errors.** A missing config file means built-in defaults. A file that exists but is not
valid JSON, or has a value of the wrong type (for example `pinned_to_claude` as a string), makes
every command and the relay stop with an error. It does not fall back to defaults, because that
would silently drop pinning and privacy settings.

**Decision log.** Every pick and every recorded outcome is appended to `balancer-log.jsonl` next
to the state file (0600, rotated to `.1` at `log.max_bytes`, 5 MB; `log.enabled: false` turns it
off). It holds agent names, verdicts, scores, outcomes, tokens, cost and duration, never prompts or keys.

**Outcome is not quality.** A `success` outcome only means the run produced a report without an
error event. `balancer-relay verdict <prompt-file> accept|reject` records what the orchestrator
actually did with the result; `balancer stats` then shows `accepted n/m` per provider and per
agent, which is the number to base `lanes.preferences` on.

### Environment overrides

| Variable | Default |
|----------|---------|
| `BALANCER_CONFIG` | `config/balancer.config.json` (missing file = built-in defaults) |
| `BALANCER_CLAUDE_STATE` | `~/.claude/usage-state.json` |
| `BALANCER_STATE` | `~/.claude/balancer-state.json` (last pick, usage cache, cooldowns, probes, breakers; never the key) |
| `BALANCER_LOG` | `balancer-log.jsonl` in the state file's directory |
| `BALANCER_OPENCODE_AUTH` | `~/.local/share/opencode/auth.json` |
| `BALANCER_OPENCODE_USAGE_FILE` | read usage JSON from this file instead of the network |
| `BALANCER_NOW` | current time in ms (tests) |
| `BALANCER_OPENCODE_BIN` / `BALANCER_CLAUDE_BIN` | `opencode` / `claude` |
| `BALANCER_RELAY_WAIT_SECONDS` | `570` |

State files are written atomically (tmp + rename). Updates to the balancer state are a
read-modify-write under a lock file (`<state>.lock`): network and process I/O happens first on a
snapshot, then the decision is made on freshly read state while the lock is held, so parallel
relays cannot both take the single probe or overwrite each other's cooldowns. A lock older than
15 s is taken over (atomically, by one process), and a process that cannot get the lock within 5 s proceeds without it rather
than fail.

## Thresholds (mirrors `config/balancer.config.json`)

| Key | Value |
|-----|-------|
| `hard_stop_percent` | 90 |
| `reserve_percent.claude` / `.opencode` | 10 / 0 |
| `inflight.ttl_minutes` / `cost_points` | 30 / 2 |
| `strategy.runs_remaining` / `min_samples` / `hysteresis_runs` / `burn_decay` | true / 10 / 2 / 0.9 |
| `relay.wrap_command` | `[]` |
| `free_lane.discover` / `discover_providers` | false / `["opencode"]` |
| `lanes.escalate_on` | `["limit", "model_gone"]` |
| `lanes.preferences` | `{}` |
| `paygo.max_runs_per_day` | 10 |
| `relay.max_run_minutes` | 180 (0 = no limit) |
| `relay.scrub_env_free` | true |
| `log.enabled` / `max_bytes` | true / 5242880 |
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
| `reactive.model_gone_cooldown_seconds` | 3600 |
| `reactive.model_gone_patterns` | see Reactive signals |
| `free_lane.enabled` / `agents` | false / [] |
| `free_lane.models` | 7 Zen free models (see Free lane) |
| `free_lane.canary_ttl_days` / `canary_timeout_seconds` | 7 / 300 |
| `free_lane.escalate_on_failure` | true |
| `free_lane.renew_canary_on_success` / `require_toolcall` / `rotate` | true / true / false |
| `catalog.ttl_seconds` / `timeout_seconds` | 600 / 20 |
| `catalog.check_agent_models` | true |

## Claude usage: statusline setup

Claude Code only exposes its rate limits to the `statusLine` command. If you already have a
`statusLine`, **chain** it by hand (never automatic; updates of other tools may rewrite it).
Change `statusLine.command` in `~/.claude/settings.json` to:

```
node /path/to/claude-opencode-go-balancer/bin/claude-usage-statusline.cjs --chain <your existing statusLine command>
```

It pipes the same stdin to the chained command, prints its output, then ` | claude 5h 42% 7d 10%`.
A failing chained command still prints our text. With no existing statusLine:

```json
{ "statusLine": { "type": "command",
  "command": "node /path/to/claude-opencode-go-balancer/bin/claude-usage-statusline.cjs" } }
```

A headless Claude run also reports these windows in its own log. After each relayed Claude run the
relay copies them into the same usage file, stamped with the start of that run, unless the
statusline has written something newer. This keeps Claude usage from going stale while no
interactive session is refreshing it.

Until the statusline has run once, Claude usage is `unknown` and the balancer falls back as above.
Claude numbers are only as fresh as the last statusline refresh (they go stale after 15 minutes).

## Relay contract

`balancer-relay` keeps the contract of the original `relay.sh`: `start` returns immediately with
`started pid <n> agent=<a> provider=<p>`; `wait` blocks up to 570 s and prints `RUNNING`, or `DONE`
followed by `----- FINAL REPORT -----`, an evidence warning if the report has no verification
output, a stderr tail, `----- ORCHESTRATOR CHECK (repo state, measured by the relay) -----`
(commits since launch, `git status --short`) and the last line `relay: <provider> (log: ...)`. A
missing report prints `relay-failure: no-report` and a salvage block of the last tool commands.
After `DONE` the relay classifies the run and updates cooldown/breaker state **once**: the result
line is stored in `.recorded`, and calling `wait` again replays it instead of counting the same
run a second time.

The relay adds its own sidecar files to `.git/info/exclude` (`.opencode-relay/`, or `/<prompt>.*`
when the prompt lives elsewhere in the repo), so they never appear as changes made by the agent.

**Timeout.** The limit is enforced by `wait`: a run nobody waits on is not killed. A provider run older than `relay.max_run_minutes` (180; the clock starts when the
provider is launched, not while deferred) is killed by the next `wait`, which prints
`relay-failure: timeout after N min` and records a failure. `balancer-relay cancel <prompt-file>`
stops a running or deferred run on request, releases its probe and in-flight slot, and counts
nothing against the provider. Both only signal a process whose command line names the prompt file,
so a reused pid is never killed.

Sidecar files next to the prompt: `.pid`, `.provider`, `.agent`, `.base`, `.jsonl`, `.err`, `.launched`, `.recorded` (plus `.model` for the free lane, `.child` for a deferred run, `.timeout`, and after an escalation `.escalated` and the first run's `.<provider>.jsonl` / `.<provider>.err`).
Scratch (`TMPDIR`, caches) is redirected to `<repo>/build/`, and standing rules are appended to the run message.

If both providers are limited, `start` prints `relay: both subscriptions limited, deferred until <ISO>`
and launches a detached worker that waits for the reset, re-picks and runs the chosen provider;
`wait` reports `RUNNING` meanwhile. If picking fails for any reason other than an invalid config (for example
an unwritable state file), the relay still launches a run without balancing: Claude for an agent in
`pinned_to_claude`, plain opencode for everything else.

## Claude permissions

Headless Claude runs with `--permission-mode acceptEdits` and
`--allowedTools` limited to `git status/diff/log/add/commit`, `node --test`, `npm test`, Read, Write and Edit, plus
`--disallowedTools Bash(git push:*)`. Broad entries such as `Bash(node:*)` or `Bash(git:*)` are deliberately absent:
they allow `node -e` (arbitrary code) and `git push`.

**This allow-list is a guard rail, not a sandbox.** An agent that can `Write` and run `npm test` or
`node --test` can put any code in a test file or the `test` script and run it, with your user's
file and network access. The same holds for the opencode and free lanes, whose permissions come
from the opencode agent definition, and "never read outside the project root" is only an
instruction in the prompt. If the prompts or repositories are not fully trusted, run the relay
inside an OS-level sandbox or container (for Claude, its own sandbox setting) and keep credentials
out of reach of that environment. `relay.wrap_command` is the hook for that: a command prefix
applied to every provider launch, with `{root}` replaced by the repository root, for example

```json
{ "relay": { "wrap_command": ["bwrap", "--ro-bind", "/", "/", "--bind", "{root}", "{root}", "--dev", "/dev", "--proc", "/proc"] } }
```

That example makes everything outside the repository read-only; a real profile also has to allow
the provider's own config and cache directories. The balancer does not ship or verify a profile. It never gets `--agent` (a project agent
file may itself be the relay agent, which would recurse). To supply the agent's instructions set
`claude.agent_prompt_dir` (e.g. `~/.claude/agents`): `<logical agent>.md` is read, frontmatter
stripped, and passed with `--append-system-prompt`. To widen permissions, edit
`claude.allowed_tools`, `claude.disallowed_tools` or `claude.permission_mode` in your config; that is an explicit choice.

## Security

- The OpenCode key is read from `auth.json` at call time into a local variable used only for the
  `Authorization` header. It is never logged, cached, stored in state or printed, and error text is
  redacted. The `User-Agent` is the generic `usage-balancer/1.0`.
- `node scripts/scan-secrets.cjs` scans tracked and untracked files for key-shaped strings and for
  the real key value, printing only `file:line rule`. `npm run install-hooks` (once per clone) makes
  it a pre-commit hook; CI runs it together with the tests on every push and pull request.
- `.gitignore` covers `auth.json`, `.env*`, state files and run logs. Tests use fixtures and an
  injected fetch; fixture keys are obviously fake.

## Caveats

- Percentages come from the providers, so no dollar caps are needed.
- The OpenCode usage endpoint is not a documented public API and may change; on any failure the
  provider is `unknown`, never an error.
- Claude window data is only as fresh as the statusline.

## OpenRouter (prepaid credits) in the free lane

Any `provider/model` opencode can run may go in `free_lane.models`, including OpenRouter ids with a nested path and
`:free` suffix (`openrouter/google/gemma-4-31b-it:free`). Log in once with `opencode auth login` (the key stays in
opencode's `auth.json`; the balancer reads it at runtime only).

A model is *paid* unless the catalog says its cost is 0. Paid models are only picked when
`free_lane.spend_guard.<provider>` exists and the live credit balance (`GET https://openrouter.ai/api/v1/credits`)
is at least `min_balance_usd`:

```json
"spend_guard": { "openrouter": { "min_balance_usd": 5, "cache_seconds": 300 } }
```

Unknown balance, fetch failure, or no guard for the provider means paid models are skipped (fail closed); free models
are unaffected. `balancer status` shows the balance and floor. Privacy: OpenRouter routes to third-party providers whose
data policies differ; check each model before opting an agent in.

## Optional: RTK token savings

If [rtk](https://github.com/rtk-ai/rtk) is on your PATH, `balancer status` appends one line with its
cumulative savings (`rtk gain -f json`). It is display-only and never affects routing. If `rtk` is
missing or fails, the line is simply omitted.

Safety notes when using RTK alongside this project:
- Install the Apache-only `rtk-oss` edition from a checksum-verified release; keep telemetry off; do not enable pipelines or the proxy.
- Commands that scan raw logs for errors (for example headless Godot output) must read the raw text:
  use `rtk bypass <cmd>` or call the tool directly. The manual `rtk summary` and `rtk test` views can omit error lines.
