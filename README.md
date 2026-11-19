# claude-opencode-go-balancer

Routes agent runs between a Claude Pro subscription (headless `claude -p`) and an OpenCode Go
subscription (`opencode run`) using the real usage each provider reports, plus limit errors seen in
runs. If both are limited it waits for the earliest reset and resumes. Node >= 22, no dependencies.

## Quick start

```
node bin/balancer.cjs status          # live usage for both providers
node bin/balancer.cjs pick my-agent   # opencode | claude | paygo | free <model> | wait <ISO>
node bin/balancer.cjs stats           # outcomes per provider and agent, learned usage per run
node bin/balancer.cjs canary          # test the opt-in free models (empty temp dir, no project data)
node bin/balancer.cjs models          # configured models missing from the catalog, unconfigured free ones
bin/balancer-relay start <agent> <prompt-file>
bin/balancer-relay wait  <prompt-file>
bin/balancer-relay cancel <prompt-file>
bin/balancer-relay verdict <prompt-file> accept|reject
npm test                              # offline tests
npm run install-hooks                 # once per clone: secret scan as a pre-commit hook
```

An opt-in free-model lane (off by default; some free models may train on your prompts) is described
in the free lane section of [docs/BALANCER.md](docs/BALANCER.md).

It is not tied to any agent framework: any opencode agent name and any prompt file that asks for a
final report work (see "Using it for any task" in [docs/BALANCER.md](docs/BALANCER.md)).

Claude usage needs the statusline hook (chained onto an existing one if present). Full strategy,
setup, thresholds and caveats: [docs/BALANCER.md](docs/BALANCER.md). A real-world config and relay
wrapper are in `examples/godotrpg/`.
