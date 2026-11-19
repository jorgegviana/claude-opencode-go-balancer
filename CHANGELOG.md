# Changelog

## 0.2.0

Defaults that change behaviour (old value in brackets):

- `reserve_percent.claude: 10`: Claude stops taking runs at 80% [90%], and the reserve is subtracted from its headroom.
- `lanes.escalate_on: ["limit", "model_gone"]`: a run that dies that way without a report is re-run once on the other subscription [no re-run].
- `relay.max_run_minutes: 180`: `wait` kills a provider run older than that [no limit].
- `paygo.max_runs_per_day: 10` [unlimited].
- `relay.scrub_env_free: true`: free-lane runs do not inherit secret-looking environment variables [full environment].
- An invalid config file is an error [silently replaced by defaults].
- Model-gone detection needs HTTP or model context [a bare `404` or `retired` matched].

Fixed: deferred worker busy-loop; a Claude run cooling the opencode lane; paygo runs recorded against the Go
subscription; repeated `wait` counting one run several times; use-it-or-lose-it bonus when a longer window is binding;
state lost between concurrent processes.

Added: state lock; in-flight accounting tied to the provider process; decision log, `balancer stats`,
`balancer pick --dry-run`; `balancer-relay cancel` and `verdict`; cost per run learned from run-log tokens and
routing on estimated runs left; Claude usage refreshed from headless run logs; `lanes.preferences`;
`free_lane.discover`, `rotate`, canary renewal on success; `relay.wrap_command`; CI workflow and pre-commit hook.

## 0.1.0

Initial version: proactive usage balancing, reactive cooldown/probe/breaker, relay, statusline, free lane.
