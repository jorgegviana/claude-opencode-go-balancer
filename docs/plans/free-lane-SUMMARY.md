---
phase: free-lane
plan: 01
status: complete
---

# Free lane: summary

All four tasks of `free-lane-PLAN.md` are implemented test-first and committed locally (nothing pushed).
Free lane is NOT enabled in any config and no real agent was routed through it.

## Commits
1. feat(free): opt-in free-lane verdict from pick through relay start/wait
2. feat(free): MODEL_GONE classification and single escalation of failed free runs
3. feat(free): model catalog, balancer canary and models commands, free-lane status
4. docs(free): free lane, model catalog, MODEL_GONE (docs, README, this summary)

## Live canary (run once, throwaway state file, empty temp dirs)
Command: `balancer canary deepseek-v4.1-flash-free glm-5.3-flash-free minimax-m3.1-flash-free --timeout 120`

```
canary opencode/deepseek-v4.1-flash-free: PASS
canary opencode/glm-5.3-flash-free: PASS
canary opencode/minimax-m3.1-flash-free: FAIL (no hello.txt created (exit 1))
exit=1
```

minimax-m3.1-flash-free is absent from the catalog, so it failed as expected (the missing-model path).

## Deviations from the plan
- Task 1: `lib/free.cjs` was written in the same step as its unit tests, so those tests were never
  observed red. The CLI and relay tests were run red first.
- Task 1: the model-gone config keys (`reactive.model_gone_*`), `catalog` and the full pattern list were
  added in Task 1 (config shape settled once), as the plan allowed; detection logic landed in Task 2.
- Task 1: `catalogHas` lives in `lib/free.cjs` and is re-exported from `lib/catalog.cjs`.
- Task 2: the free-run escalation records the failure itself and, if escalation is impossible (binary
  missing), reuses that summary line instead of recording twice.
- Task 3: the catalog check for opencode-lane agent models runs for any agent with an
  `opencode.agent_models` entry, including pinned ones (one cached read per TTL).
- Task 3: `status` lists the free-model lines whether or not the lane is enabled, so canary results can
  be inspected before enabling.
- Fixtures: `fake-common.cjs` also gained `FAKE_CALL_LOG` (append argv per invocation) so tests can
  assert that no `opencode` exec happened.
