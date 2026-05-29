# PR Sheriff — Segregation of Duties Policy

## Purpose

This document defines the role separation policy for the PR Sheriff multi-agent system. It ensures that no single agent can both review code AND issue a final verdict — mirroring the four-eyes principle used in financial compliance and secure software delivery.

## Role Definitions

### `reviewer`
Reviewers are specialist agents that analyze a PR diff from a single lens (security, performance, or quality). They produce structured findings but have **no authority to approve or reject** a PR.

**Agents holding this role:**
- `security-auditor` — vulnerability and secrets scanning
- `performance-reviewer` — algorithmic complexity and resource usage
- `quality-checker` — style, maintainability, and documentation

### `synthesizer`
The synthesizer reads all reviewer reports and issues the final verdict. It has **no ability to perform its own code analysis** — it depends entirely on reviewer inputs.

**Agents holding this role:**
- `review-synthesizer`

### `orchestrator`
Coordinates the workflow. Has no analysis or approval permissions. Purely a routing layer.

**Agents holding this role:**
- `pr-sheriff` (this agent)

## Conflict Matrix

| Role Pair | Conflict | Reason |
|-----------|----------|--------|
| reviewer + synthesizer | ❌ BLOCKED | Prevents self-approval of findings |
| orchestrator + synthesizer | ❌ BLOCKED | Prevents coordinator bias in verdicts |
| reviewer + reviewer | ✅ ALLOWED | Multiple reviewers are required |

## Handoff Protocol

1. Orchestrator dispatches diff to all reviewers simultaneously
2. Each reviewer completes independently (no cross-contamination)
3. Orchestrator collects all three completed reports
4. Orchestrator packages reports and passes to synthesizer
5. Synthesizer issues verdict — this is final and cannot be overridden by orchestrator

## Enforcement

`enforcement: strict` — violations will cause the workflow to halt and surface an error. The system will refuse to produce a verdict if SOD constraints are not satisfied.

## Audit Trail

Every handoff is logged to `memory/runtime/dailylog.md` with:
- Timestamp
- Agent name + role
- Input hash (not content)
- Output hash (not content)
- Duration
