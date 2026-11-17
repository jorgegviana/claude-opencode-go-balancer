# OpenRouter via the free lane, with a spend guard

Goal: let `free_lane.models` hold OpenRouter models (cheap paid ones funded by prepaid credits, and `:free` ones)
without risking an unbounded spend.

1. Model ids: accept `provider/seg[/seg...]` with `:` and `~` in later segments
   (e.g. `openrouter/google/gemma-4-31b-it:free`). Still no `..`, no leading `-`, never a shell string.
2. Paid vs free: a model is free when the cached catalog says cost 0; with no catalog, only a `:free` / `-free` suffix counts.
3. Spend guard: `free_lane.spend_guard.<provider> = {min_balance_usd, cache_seconds}`. A paid model is only picked when
   its provider has a guard AND the live balance (`GET https://openrouter.ai/api/v1/credits`, key read at runtime from
   opencode's auth.json, never stored) is >= the floor. Unknown balance, missing guard or fetch failure all fail CLOSED
   for paid models; free models are unaffected.
4. Status shows the balance and floor. Balance is cached in state (no key stored).
5. Tests offline (injected fetch). Docs: BALANCER.md. Default stays disabled / no guard configured.
