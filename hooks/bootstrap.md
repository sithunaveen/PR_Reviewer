# PR Sheriff — Bootstrap Hook

## On Startup

When the PR Sheriff orchestrator initializes:

1. **Load all sub-agent definitions** from `agents/` directory
2. **Validate SOD policy** — run `gitagent validate --compliance` equivalent
3. **Check GitHub API connectivity** — verify token if provided
4. **Initialize memory log** — ensure `memory/runtime/dailylog.md` is writable
5. **Announce readiness** — emit `{ "type": "ready", "agents": [...] }` event

## Failure Modes

- If SOD validation fails → halt with clear error message, do NOT proceed
- If an agent definition is missing SOUL.md → halt with agent name in error
- If Anthropic API is unreachable → surface error immediately, don't queue jobs
