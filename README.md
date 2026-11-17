# claude-opencode-go-balancer

Routes agent runs between a Claude Pro subscription (headless `claude -p`) and an OpenCode Go
subscription (`opencode run`) using the real usage each provider reports, plus limit errors seen in
runs. If both are limited it waits for the earliest reset and resumes. Node >= 22, no dependencies.

## Quick start

```
node bin/balancer.cjs status          # live usage for both providers
node bin/balancer.cjs pick my-agent   # opencode | claude | paygo | wait <ISO>
bin/balancer-relay start <agent> <prompt-file>
bin/balancer-relay wait  <prompt-file>
npm test                              # offline tests
npm run scan-secrets                  # run before every commit
```

Claude usage needs the statusline hook (chained onto an existing one if present). Full strategy,
setup, thresholds and caveats: [docs/BALANCER.md](docs/BALANCER.md). A real-world config and relay
wrapper are in `examples/godotrpg/`.
