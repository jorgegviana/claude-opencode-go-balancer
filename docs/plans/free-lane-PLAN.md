---
phase: free-lane
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/plans/free-lane-PLAN.md
  - lib/config.cjs
  - config/balancer.config.json
  - lib/free.cjs
  - lib/catalog.cjs
  - lib/canary.cjs
  - lib/reactive.cjs
  - lib/engine.cjs
  - bin/balancer.cjs
  - bin/balancer-relay
  - test/free.test.cjs
  - test/catalog.test.cjs
  - test/canary.test.cjs
  - test/reactive.test.cjs
  - test/relay.test.cjs
  - test/cli.test.cjs
  - test/fixtures/bin/fake-common.cjs
  - test/fixtures/logs/opencode-crash.jsonl
  - test/fixtures/models/opencode.txt
  - test/fixtures/models/opencode-go.txt
  - docs/BALANCER.md
  - README.md
autonomous: true
requirements: [FREE-1a, FREE-1b, FREE-1c, FREE-1d, CAT-2a, CAT-2b, CAT-2c, DOCS]

estimate:
  tokens: 70000
  raw_tokens: 70000
  tasks: 4
  confidence: low

must_haves:
  truths:
    - "With free_lane absent or enabled:false, every existing test passes unchanged and pick never prints a free verdict (backward compatible with the godotrpg consumer's generated config)"
    - "pick <agent> prints 'free opencode/<id>' only when free_lane.enabled, the logical agent is in free_lane.agents, the agent is not pinned to claude, and a configured free model is canary-passed (within canary_ttl_days), not in model cooldown, breaker not open, and not missing from a successfully read catalog"
    - "The free decision never reads Go or Claude usage; a free pick works with the usage file missing"
    - "balancer-relay runs a free verdict as 'opencode run ... --agent <agent> --model opencode/<id>' with the same env and standing rules, writes .provider=free and .model, and its last line is 'relay: free (log: ...)'"
    - "A free run with no report is recorded against the model only (never state.providers.opencode); when escalate_on_failure it re-picks once with the free lane excluded, launches that run, and the final DONE output contains 'relay: escalated from free'; a second escalation never happens"
    - "Log errors matching model-gone patterns are classified model_gone: per-model cooldown of reactive.model_gone_cooldown_seconds (3600), no provider cooldown, no breaker increment"
    - "balancer canary runs a hello.txt task in a fresh empty temp dir outside any repo, passes only when hello.txt contains exactly ok, stores {ok, ts, detail} in state.canary, and removes the temp dir"
    - "balancer models lists configured models missing from the catalog and free (cost 0) catalog models not configured; a failed catalog read is fail-open everywhere"
    - "status shows free lane enabled/disabled, per-model canary age, cooldowns, breaker, catalog freshness"
  artifacts:
    - path: lib/free.cjs
      provides: "pure free-lane selection: normalizeModel, freeAgentAllowed, freeModelStatus, pickFreeModel"
    - path: lib/catalog.cjs
      provides: "parseCatalog(text, provider), getCatalog with TTL cache in state, catalogHas (fail-open)"
    - path: lib/canary.cjs
      provides: "runCanary({model, exec, timeoutSeconds, bin}) in a fresh temp dir"
    - path: test/free.test.cjs
      provides: "free selection unit tests"
    - path: test/catalog.test.cjs
      provides: "catalog parse/cache/fail-open tests"
    - path: test/canary.test.cjs
      provides: "canary tests with injected exec"
  key_links:
    - from: lib/engine.cjs pick
      to: lib/free.cjs pickFreeModel
      via: "called before gather(); returns early with verdict free"
    - from: bin/balancer-relay wait
      to: lib/engine.cjs pick(ctx, agent, {excludeFree:true})
      via: "single escalation guarded by the .escalated sidecar"
    - from: lib/engine.cjs recordRun
      to: lib/reactive.cjs recordOutcome
      via: "provider free uses the model id as key; outcome model_gone sets state.modelCooldowns"
    - from: lib/reactive.cjs applyReactive
      to: state.modelCooldowns
      via: "opencode lane key in model cooldown makes opencode ineligible for that agent"
---

<objective>
Add an opt-in free-model lane and model-catalog handling to the balancer.

STEP 1 (free lane): config `free_lane`, a `free` verdict from `pick`, relay support with a single
automatic escalation to the normal lanes on failure, and a `balancer canary` command.
STEP 2 (404 and catalog): MODEL_GONE classification with a long per-model cooldown, a cached
`opencode models <provider> --verbose` catalog with a `balancer models` command, catalog-based
dropping in pick/relay (fail open), and free-lane info in `status`. Docs updated.

Purpose: run cheap/free models for explicitly opted-in agents without touching Go/Claude quota,
and stop routing to retired or missing models.
Output: lib/free.cjs, lib/catalog.cjs, lib/canary.cjs, changes to engine/reactive/config/CLI/relay,
offline tests, docs.

Executor note: this plan is executed by a general-purpose Claude agent working directly in this
repo (not the opencode-relayed gsd-executor). All paths are relative to the balancer repo root.
Do not touch the godotrpg consumer repo: its free-lane.json / balancer-config.cjs merge is a
separate follow-up. Backward compatibility is a hard requirement: a config with no `free_lane`
key must behave exactly as today.
</objective>

<execution_context>
Run everything from the balancer repo root. Test command (the directory form fails on Node 24):
`node --test test/*.test.cjs`. Node >= 22, zero dependencies: use only node built-ins.
TDD: for each task write/extend the failing tests first, run them red, implement, run green.

Commit rules (local only, NEVER push, never change git config; the repo-local noreply identity
is already set):
- Before every commit run `node scripts/scan-secrets.cjs` and fix any hit.
- No tokens, no absolute personal paths (home directories, user names) in any file, test or log
  you add. Tests use os.tmpdir() and fixtures.
- One commit per task, conventional message, ending with the line
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- The first commit (Task 1) also adds this plan file, docs/plans/free-lane-PLAN.md.
</execution_context>

<context>
Read fully before Task 1: README.md, docs/BALANCER.md, config/balancer.config.json, lib/*.cjs,
bin/balancer.cjs, bin/balancer-relay, test/*.test.cjs, test/fixtures (bin/fake-common.cjs,
bin/fake-opencode, logs/*).

Facts the plan relies on (verified while planning):
- `deepMerge` in lib/config.cjs replaces arrays wholesale and adds unknown keys, so a user
  `free_lane.agents` list replaces the default and a missing `free_lane` yields the defaults.
- `opencode models <provider> --verbose` prints, per model, a header line `<provider>/<id>`
  followed by a pretty-printed JSON object with keys including `id`, `status` ("active"),
  `cost.input`, `cost.output` (0 for free models) and `capabilities.toolcall`. Splitting the text
  with the multiline regex `^(<provider>\/\S+)$` and JSON-parsing each following block works.
  The read takes about 1 s. The `opencode` catalog currently has 88 models; free ones include
  deepseek-v4.1-flash-free, glm-5.3-flash-free, mimo-v2.6-flash-free, longcat-2.5-free,
  hy4-flash-free, big-pickle (minimax-m3.1-flash-free is NOT present: a good "missing" case).
- The consumer's `opencode.agent_models` values use the `opencode-go/` provider prefix, while
  free models use `opencode/`. The catalog must therefore be per provider prefix: a model is
  "missing" only if the catalog of ITS provider was read successfully and lacks it.
- test/fixtures/logs/opencode-failure.jsonl contains the message "model not found". Today it is
  the generic-failure fixture (test/reactive.test.cjs lines 33 and 220). After Task 2 it is a
  model_gone case, so those two assertions move to a new generic fixture.
- The relay agents loop on `wait` while it prints `RUNNING`; keep `RUNNING` as the only stdout
  of a still-running wait.
</context>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1 (tracer): free verdict end-to-end, config to pick to relay start/wait</name>
  <files>docs/plans/free-lane-PLAN.md, lib/config.cjs, config/balancer.config.json, lib/free.cjs, lib/engine.cjs, bin/balancer.cjs, bin/balancer-relay, test/free.test.cjs, test/cli.test.cjs, test/relay.test.cjs</files>
  <behavior>
    - defaults().free_lane is {enabled:false, models:[7 ids below], agents:[], canary_ttl_days:7, canary_timeout_seconds:300, escalate_on_failure:true}; loadConfig of a consumer-shaped config (lanes/claude/opencode.agent_models only, no free_lane) gives free_lane.enabled false.
    - normalizeModel('glm-5.3-flash-free') returns 'opencode/glm-5.3-flash-free'; 'opencode/x-free' unchanged; '-rf', '', 'a b', 'opencode/../x' return null.
    - pickFreeModel: enabled + allowed agent + first model canary ok 1 h ago returns that model; models are tried in config order and skipped when: no canary, canary ok:false, canary older than canary_ttl_days, state.modelCooldowns[model].until in the future, breaker open on the model key (breakerPeek), or catalogHas false. Returns {model:null, reason} when none qualifies.
    - freeAgentAllowed is false when enabled is false, when the logical agent is not listed, and when the agent is in lanes.pinned_to_claude (pin wins).
    - CLI: `pick go-gsd-executor` with a free-enabled config and a pre-seeded passing canary prints exactly 'free opencode/glm-5.3-flash-free' on stdout line 1, even with BALANCER_OPENCODE_USAGE_FILE pointing at a missing file. With enabled false, agent not listed, or no canary it prints the existing verdict (opencode/claude) exactly as before. state.lastPick is not changed by a free pick.
    - Relay: start prints 'started pid N agent=go-gsd-executor provider=free model=opencode/glm-5.3-flash-free'; argv of the fake starts with 'run' and contains '--agent go-gsd-executor' and '--model opencode/glm-5.3-flash-free'; TMPDIR is the repo build/tmp; .provider is 'free' and .model holds the model; wait prints the FAKE OPENCODE REPORT and its last line is 'relay: free (log: <prompt>.jsonl)'; after a successful free run state.providers.opencode is undefined.
  </behavior>
  <action>
    Tracer slice: one free agent, one canary-passed model, happy path only, through every layer.
    The catalog is treated as unknown (fail open) in this task; Task 3 fills it in without any
    signature change.

    Config (FREE-1a): in lib/config.cjs defaults() add `free_lane` with enabled false, models in this
    order: opencode/deepseek-v4.1-flash-free, opencode/glm-5.3-flash-free,
    opencode/mimo-v2.6-flash-free, opencode/minimax-m3.1-flash-free, opencode/longcat-2.5-free,
    opencode/hy4-flash-free, opencode/big-pickle; agents empty; canary_ttl_days 7;
    canary_timeout_seconds 300; escalate_on_failure true. Also add now (used by Tasks 2/3, so the
    config shape is settled once): `catalog` {ttl_seconds:600, timeout_seconds:20,
    check_agent_models:true} and under `reactive`: model_gone_cooldown_seconds 3600 and
    model_gone_patterns (see Task 2). Mirror all of it in config/balancer.config.json.

    lib/free.cjs (pure, no I/O, time injected): export normalizeModel (accept `provider/id` or a
    bare id which gets the `opencode/` prefix; validate each part against
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and reject `..`; return null when invalid so a model string can
    never become a CLI flag), freeAgentAllowed(logical, cfg), freeModelStatus(model, {cfg, state,
    catalogs, now}) returning {ready, why, until?} where why is one of 'ready', 'no canary',
    'canary failed', 'canary expired', 'cooldown', 'breaker open', 'missing from catalog', and
    pickFreeModel({logical, cfg, state, catalogs, now}) returning {model, reason}. catalogs is a map
    provider-prefix to models-map-or-null; for now define catalogHas(catalogs, model) here or in a
    tiny helper that returns true when the provider entry is absent or null (fail open). State
    shape: state.canary[model] = {ok, ts, detail}; state.modelCooldowns[model] = {until, hits,
    reason}; breakers reuse state.breakers keyed by the full model id (cannot collide with
    opencode-go keys). Invalid model entries in free_lane.models are skipped.

    lib/engine.cjs (FREE-1b): change pick(ctx, agent, opts = {}) with opts.excludeFree. Before
    gather(): if !excludeFree and freeAgentAllowed, call pickFreeModel with catalogs {} (Task 3
    replaces this with real catalogs). On a model: call R.breakerAllow(state, model, ...) to claim
    a half-open attempt, saveState, return {verdict:'free', model, balanced:false, reason}. Do not
    gather usage, do not touch lastPick. Otherwise fall through to the current code unchanged,
    appending the free skip reason to d.reason only when the agent was free-allowed.

    bin/balancer.cjs: cmdPick prints `free <model>` for the free verdict; everything else as today.

    bin/balancer-relay (FREE-1c, happy path): accept verdict 'free' in start (and in the
    deferred worker re-pick). Factor a launch helper used by start and deferred so the free path
    is not duplicated. providerArgs for 'free' builds exactly the opencode args (same message with
    RULES, --agent, --dir, --format json, -f prompt) plus `--model <model>`; binFor('free') is the
    opencode bin; childEnv treats 'free' like 'opencode' (same hardened env). spawnProvider writes
    `.provider` 'free' and a `.model` sidecar. start prints the started line with
    ` model=<model>` appended for free. In wait, read provider from .provider allowing
    'claude' | 'free' | 'opencode' (anything else stays 'opencode'); for free read .model and pass
    it to recordRun. In engine.recordRun accept `model` and use it as the reactive key when
    provider is 'free'; in R.recordOutcome make provider 'free' touch only the model key (success:
    delete state.modelCooldowns[model] and close its breaker; failure: recordBreaker on the model;
    never recordSuccess/recordLimit on state.providers). Task 2 completes limit/model_gone.
    Add `.model` and `.escalated` to .gitignore next to the other sidecars.

    Tests first: new test/free.test.cjs for the pure functions; extend test/cli.test.cjs and
    test/relay.test.cjs (write a cfg json in the temp dir and a pre-seeded state file with
    canary {ok:true, ts: NOW - 3600e3}) for the CLI and relay behaviors listed. Commit including
    docs/plans/free-lane-PLAN.md.
  </action>
  <verify>
    <automated>node --test test/*.test.cjs</automated>
  </verify>
  <done>All tests pass, including the new free tests; pick prints 'free opencode/...' only under the opt-in conditions; a relayed free run ends with 'relay: free (log: ...)'; commit made with scan-secrets clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: MODEL_GONE classification and single escalation of failed free runs</name>
  <files>lib/reactive.cjs, lib/engine.cjs, bin/balancer-relay, test/reactive.test.cjs, test/relay.test.cjs, test/fixtures/bin/fake-common.cjs, test/fixtures/logs/opencode-crash.jsonl</files>
  <behavior>
    - detectLimitError on opencode-failure.jsonl ("model not found") returns {limit:false, modelGone:true}; on raw lines 'Error: model_not_found', 'HTTP 404 Not Found', 'model foo does not exist', 'this model has been retired' returns modelGone true; on the new opencode-crash.jsonl returns exactly {limit:false}; limit fixtures still return limit:true with the same hints; success fixtures still null.
    - recordRun opencode + model_gone: state.modelCooldowns[breakerKey].until == NOW + 3600 s, reason 'model_gone'; state.providers.opencode has no cooldown (probe released); breaker failures unchanged; summary line 'balancer: opencode model_gone <key>; cooldown until <ISO>'.
    - applyReactive: opencode becomes ineligible (eligibleAt = cooldown until) for the agent whose key is in modelCooldowns, while other agents still get opencode.
    - provider free: limit -> modelCooldowns[model] with the provider backoff formula or the log hint, reason 'limit'; model_gone -> 3600 s; failure -> breaker on the model; none of them create state.providers.opencode or state.providers.claude.
    - pickFreeModel skips a model in cooldown and picks the next one in order.
    - Relay escalation: free run of a FAKE_FAIL_MODEL with an empty log, escalate_on_failure true, opencode usage ok -> wait prints DONE, the FAKE OPENCODE REPORT of the escalated run, a line 'relay: escalated from free (opencode/<id>: failure) to opencode', last line 'relay: opencode (log: ...)'; the second fake invocation has no '--model'; the free logs are kept as <prompt>.free.jsonl / .free.err; .escalated exists; state.breakers[model].failures == 1.
    - Never loop: with .escalated already present (or escalate_on_failure false) a failed free run prints relay-failure: no-report and last line 'relay: free (log: ...)', no new run.
    - Existing CLI record test still asserts breaker failures 1, now using opencode-crash.jsonl.
  </behavior>
  <action>
    CAT-2a: add to defaults (already declared in Task 1, fill the list now) reactive.model_gone_patterns:
    'model[ _-]?not[ _-]?found', 'model_not_found', '\\b404\\b', 'model\\b[^\\n]{0,120}does not exist',
    'retired'. The "does not exist" pattern requires the word model on the same line so a tool
    error such as a missing file does not cool a model for an hour (planner discretion, documented).
    In detectLimitError check model_gone patterns first over the same error/raw haystack and
    return {limit:false, modelGone:true}; keep the exact {limit:false} shape (no extra key) for
    other errors. Add recordModelCooldown(state, key, {reason, hint}, cfg, now): model_gone uses
    model_gone_cooldown_seconds; limit uses the same backoff/hint math as recordLimit but on
    state.modelCooldowns[key].hits. Extend recordOutcome with outcome 'model_gone' (any provider:
    model cooldown on key, recordFailure to release the provider probe, no breaker change, no
    provider cooldown) and full provider 'free' handling (limit -> recordModelCooldown reason limit).
    applyReactive: for opencode with a key, a future state.modelCooldowns[key].until also makes it
    ineligible (max with breaker/cooldown until). recordRun: outcome model_gone when det.modelGone;
    summary lines for model cooldowns name the key and ISO until.

    Fixtures: add test/fixtures/logs/opencode-crash.jsonl with one generic error event (for example
    name UnknownError, message "stream closed unexpectedly") and repoint the two existing generic
    failure assertions in test/reactive.test.cjs (detectLimitError {limit:false} and the CLI record
    breaker test) to it; add model_gone assertions for opencode-failure.jsonl.
    test/fixtures/bin/fake-common.cjs: when FAKE_FAIL_MODEL is set and argv has '--model' equal to
    it, print the contents of FAKE_FAIL_LOG (default: nothing) instead of the normal lines.

    FREE-1c escalation in bin/balancer-relay wait: restructure into a loop over the current pid
    with one shared deadline. When the pid is dead and provider is 'free' and extractReport gives
    no report: recordRun(provider free, model, extraFailure true); if cfg.free_lane.escalate_on_failure
    and no `.escalated` sidecar: rename .jsonl/.err to .free.jsonl/.free.err, write .escalated
    ('<model> <outcome> -> <verdict>'), d = safePick-style call of engine.pick(ctx, agent,
    {excludeFree:true}), launch via the Task 1 helper (a wait verdict starts the deferred worker,
    whose re-pick must also pass excludeFree when .escalated exists), update .pid, write one stderr
    note, and keep waiting on the new pid within the remaining deadline. A still-running wait prints
    only RUNNING. The DONE output of an escalated run prints, just before the final 'relay:' line,
    'relay: escalated from free (<model>: <outcome>) to <provider>'. The ORCHESTRATOR CHECK keeps
    using the original .base so it covers both runs. Escalation happens at most once per prompt:
    the .escalated sidecar and excludeFree both guarantee it.
  </action>
  <verify>
    <automated>node --test test/*.test.cjs</automated>
  </verify>
  <done>model_gone is a distinct outcome with a 1 h per-model cooldown that never touches provider state; a failed free run escalates exactly once and the DONE output reports it; all tests pass; commit made with scan-secrets clean.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: catalog, balancer models, balancer canary, status free-lane section</name>
  <files>lib/catalog.cjs, lib/canary.cjs, lib/engine.cjs, bin/balancer.cjs, test/catalog.test.cjs, test/canary.test.cjs, test/cli.test.cjs, test/fixtures/bin/fake-common.cjs, test/fixtures/models/opencode.txt, test/fixtures/models/opencode-go.txt</files>
  <behavior>
    - parseCatalog(fixture text, 'opencode') returns a map keyed 'opencode/<id>' with {free, status, toolcall}; free is true only when cost.input and cost.output are both 0; garbage or empty text returns null.
    - getCatalog: fresh cache (< ttl_seconds) does not call exec; stale cache calls exec once with ['models', provider, '--verbose'] and the configured timeout; exec failure, timeout or unparseable output returns null (fail open) and caches the failure {ts, ok:false, error} so the next pick inside the TTL does not exec again; refresh:true bypasses the cache.
    - pick: free model missing from a successfully read 'opencode' catalog is skipped (next one chosen); catalog read failure keeps all models eligible; an opencode-lane agent whose agent_models value is missing from its provider's catalog gets claude (or wait) with reason naming the missing model; catalog exec happens only when there is a model to check (free-allowed agent or agent_models entry), so default-config picks never spawn opencode.
    - runCanary with injected exec: exec receives cwd = a fresh empty dir under os.tmpdir() that is not inside the current repo, args containing 'run', '--model', the model, '--dir' that dir, '--format', 'json' and no '-f' and no '--agent'; pass when hello.txt content is 'ok' (one trailing newline tolerated); fail with detail for missing file, wrong content, timeout; the dir is removed afterwards in every case.
    - CLI canary: `canary opencode/a-free opencode/b-free` with the fake opencode writing hello.txt for a-free only prints 'canary opencode/a-free: PASS' and 'canary opencode/b-free: FAIL (...)', exits 1, and state.canary holds both with ts = BALANCER_NOW; no args means all free_lane.models; invalid model names exit 2; --timeout N overrides.
    - CLI models: with fake catalogs, prints configured models missing from the catalog (with where they are configured, e.g. free_lane.models or opencode.agent_models.<agent>) and free catalog models not configured; --refresh bypasses the cache; exits 1 if any catalog is unavailable.
    - CLI status: includes 'free lane: disabled' or 'free lane: enabled (agents: ...)', one line per configured free model with canary pass/fail and age, cooldown or breaker until, missing-from-catalog, and a 'catalog:' line with per-provider age and model count or 'not loaded'; status reads only cached catalog state (no exec).
  </behavior>
  <action>
    CAT-2b lib/catalog.cjs: parseCatalog(text, provider) as in the context facts; getCatalog({exec,
    bin, cfg, state, provider, now, refresh}) caching in state.catalog[provider] = {ts, ok, models}
    or {ts, ok:false, error} (error text sanitized and clipped, no paths); catalogsFor(models list)
    collects the unique provider prefixes. Move/keep catalogHas next to it (null or absent ->
    true). engine: makeCtx gains `exec` (default: child_process.spawnSync wrapper returning
    {status, stdout, stderr, timedOut} with encoding utf8, killSignal SIGKILL, timeout ms, stdin
    ignored) and `opencodeBin` (BALANCER_OPENCODE_BIN or opencode). In pick, load the catalogs
    needed (free candidates, and agent_models[logical] when cfg.catalog.check_agent_models) and
    pass them to pickFreeModel; for the opencode lane, a missing agent model makes the opencode
    score ineligible until the catalog entry expires before decide() runs. Fail open everywhere.
    Add fixtures test/fixtures/models/opencode.txt (a handful of entries in the real format: two or
    three free models from the default list, big-pickle, one paid model, one unconfigured free
    model such as beam-free; deliberately omit minimax-m3.1-flash-free) and
    test/fixtures/models/opencode-go.txt. fake-common.cjs: when argv[0] is 'models', print
    FAKE_MODELS_DIR/<argv[1]>.txt and exit 0, or exit 1 when unset or missing, BEFORE writing
    FAKE_ARGV_FILE (so it never clobbers the argv dump of the real run). When FAKE_WRITE_HELLO is
    set and argv has '--model' matching FAKE_WRITE_HELLO_MODEL (or any model when that is unset),
    write FAKE_WRITE_HELLO into <cwd>/hello.txt.

    FREE-1d lib/canary.cjs: runCanary({model, exec, bin, timeoutSeconds, env}) creates
    fs.mkdtempSync(path.join(os.tmpdir(), 'balancer-canary-')), runs bin with ['run', TASK,
    '--model', model, '--dir', dir, '--format', 'json'] and cwd dir, env = process env with TMPDIR
    set to dir (no project data, no attached files, no agent). TASK: "Create a file named hello.txt
    in the current directory containing exactly ok using your file tools. Do not run shell
    commands. Then print DONE." Pass iff hello.txt exists and its content without one trailing
    newline is 'ok'. Return {ok, detail, seconds}; always rm -rf the dir in finally. engine
    runCanaries(ctx, models, {timeoutSeconds}) records state.canary[model] = {ok, ts, detail}.
    CLI `canary [model...] [--timeout N]` normalizes and validates names (exit 2 on invalid),
    defaults to free_lane.models, runs sequentially, prints one line per model, exits 0 only if
    all pass.

    CAT-2b CLI `models [--refresh]` and CAT-2c status section as in behavior; update the usage
    string. Keep status otherwise identical (existing status test must still pass).
  </action>
  <verify>
    <automated>node --test test/*.test.cjs</automated>
  </verify>
  <done>Catalog is cached per provider for 10 min and fail-open; models/canary/status commands behave as specified with fakes only; all tests pass; commit made with scan-secrets clean.</done>
</task>

<task type="auto">
  <name>Task 4: docs, optional single live canary, final gate</name>
  <files>docs/BALANCER.md, README.md</files>
  <action>
    DOCS: in docs/BALANCER.md add a "Free lane (opt-in, off by default)" section: config block
    with every free_lane key and default; selection rules (enabled, agent allow-list, pin wins,
    canary within canary_ttl_days, cooldown, breaker, catalog), independence from Go/Claude usage,
    the `free <model>` verdict, relay behavior and the single escalation with the
    'relay: escalated from free' line and the .free.jsonl / .model / .escalated sidecars.
    A prominent privacy warning: some OpenCode Zen free models may log or train on prompts and
    outputs, so only list agents whose prompts you are willing to share, and the default agent
    list is empty. How to enable: run `node bin/balancer.cjs canary`, check `status`, then set
    `free_lane.enabled: true` and add agents. Rollback: set `enabled: false` (or remove the agent).
    Extend "Reactive signals" with MODEL_GONE (patterns, 1 h per-model cooldown, never counts
    against the provider). Add a "Model catalog" section (per-provider `opencode models <provider>
    --verbose`, 10 min cache, fail open, opencode-lane agent models also checked, `models`
    command). Add canary/models to Commands and the new keys to the Thresholds table. README: add
    the two commands to Quick start and one sentence on the opt-in free lane pointing to the docs.

    Optional live check (allowed ONCE, zero cost): run `node bin/balancer.cjs canary` against 2-3
    free models from the default list (for example deepseek-v4.1-flash-free, glm-5.3-flash-free,
    minimax-m3.1-flash-free to see the missing-model path) with BALANCER_STATE pointing at a
    throwaway file under os.tmpdir() so live relay state is not clobbered. It runs in an empty
    temp dir with no project data. Report the raw output lines verbatim in the summary. Do NOT
    enable the free lane in any config and do not route any real agent through it. If opencode is
    unavailable or the run fails, report that; it does not block the task.

    Final gate: full test suite, scan-secrets, then commit the docs.
  </action>
  <verify>
    <automated>node --test test/*.test.cjs && node scripts/scan-secrets.cjs && grep -c "free_lane" docs/BALANCER.md && grep -ci "train" docs/BALANCER.md && grep -c "canary" README.md</automated>
  </verify>
  <done>Docs describe the free lane, privacy warning, enable and rollback, MODEL_GONE and catalog; README mentions it; all tests pass; scan clean; docs committed; live canary results (if run) reported verbatim.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| balancer -> free Zen models | prompts and repo content leave the machine to providers that may train on them |
| run logs -> reactive classifier | log text is model/provider controlled and can contain forged error strings |
| config/CLI args -> opencode argv | model names become command-line arguments |
| opencode catalog output -> pick | external CLI output decides routing |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-FL-01 | Information disclosure | free lane routing | high | mitigate | enabled false and agents empty by default; per-agent allow-list; pinned agents never go free; docs privacy warning; canary uses an empty temp dir with no project data and no attached files |
| T-FL-02 | Tampering | model names to argv | medium | mitigate | normalizeModel regex rejects leading '-', spaces and '..'; spawn without a shell; CLI exits 2 on invalid names |
| T-FL-03 | Denial of service | forged model-gone / limit strings in logs | low | accept | only error events and raw lines are scanned; effect is a bounded per-model cooldown (max 1 h) and fallback to another lane; "does not exist" requires the word model |
| T-FL-04 | Denial of service | escalation loop | medium | mitigate | .escalated sidecar plus excludeFree on the re-pick; tests assert no second escalation |
| T-FL-05 | Denial of service | catalog exec hang or failure | low | mitigate | spawnSync timeout with SIGKILL, failure cached for the TTL, fail open |
| T-FL-06 | Information disclosure | state, logs, committed files | medium | mitigate | no key or personal path stored; catalog errors sanitized; scan-secrets before every commit; canary temp dir removed in finally |
| T-FL-SC | Tampering | package installs | low | accept | no packages are installed: node built-ins only |
</threat_model>

<verification>
- `node --test test/*.test.cjs` passes after every task (existing tests unchanged except the two
  repointed generic-failure assertions in test/reactive.test.cjs).
- A config with no free_lane key: pick never prints free, and no catalog exec happens unless an
  agent_models entry exists for the agent.
- `node scripts/scan-secrets.cjs` clean before each of the 4 commits; nothing pushed.
</verification>

<success_criteria>
- FREE-1a..1d, CAT-2a..2c and DOCS are implemented as specified, offline-tested with injected
  exec/clock and fake binaries.
- The godotrpg consumer's current generated config works unchanged.
- Four local commits, the first including this plan; no push; no git config changes.
</success_criteria>

<output>
Report back (no SUMMARY file needed in this repo unless convenient): commit hashes and subjects,
test counts, scan-secrets result, raw live-canary output lines if run, and any deviation from this
plan with the reason.
</output>
