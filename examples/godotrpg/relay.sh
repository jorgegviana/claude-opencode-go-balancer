#!/usr/bin/env bash
# Thin wrapper so a project can swap its own relay.sh for the balancer relay by hand.
#   relay.sh start <agent> <prompt-file> | wait <prompt-file>
# BALANCER_HOME: checkout of claude-opencode-go-balancer (default below).
# BALANCER_CONFIG: optional config, e.g. $BALANCER_HOME/examples/godotrpg/routing.balancer.json
set -uo pipefail
BALANCER_HOME="${BALANCER_HOME:-$HOME/git/jorgegviana/claude-opencode-go-balancer}"
exec node "$BALANCER_HOME/bin/balancer-relay" "$@"
