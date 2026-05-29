# PR Sheriff 🔍

> **Multi-agent GitHub PR review with strict Segregation of Duties — built on [GitAgent](https://github.com/open-gitagent/gitagent)**

[![GitAgent Spec](https://img.shields.io/badge/gitagent-v0.1.0-blue)](https://github.com/open-gitagent/gitagent)
[![SOD](https://img.shields.io/badge/SOD-enforced-purple)](./DUTIES.md)
[![Stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20Next.js-green)](.)

---

## The Idea

Every PR review tool I've seen uses one AI model to do everything: analyze security, check performance, assess quality, and then approve — all in one shot. That's like having your developer write code, review it, and merge it themselves.

PR Sheriff applies the **four-eyes principle** at the agent level:

```
GitHub PR URL
     ↓
  [Fetch Diff]
     ↓
  ┌──────────────────────────────────┐
  │   Parallel Review (role: reviewer) │
  │  ┌──────────┐ ┌──────────┐ ┌────┐│
  │  │ Security │ │ Perf     │ │QA  ││
  │  │ Auditor  │ │ Reviewer │ │    ││
  │  └──────────┘ └──────────┘ └────┘│
  └──────────────────────────────────┘
     ↓
  [SOD Checkpoint] ← validates no conflict
     ↓
  [Review Synthesizer] (role: synthesizer)
  ← receives ONLY the three reports, never the raw diff
     ↓
  Final Verdict: APPROVE / REQUEST CHANGES / BLOCKED
```

The key constraint: **reviewer agents cannot hold the synthesizer role**. This is enforced at the `strict` level by the GitAgent SOD policy — the system refuses to run if a single agent holds both roles.

---

## Architecture

### Agent Definitions (GitAgent Standard)

Each agent is a self-contained GitAgent repository:

```
agents/
├── security-auditor/      # role: reviewer
│   ├── agent.yaml         # manifest + SOD role declaration
│   ├── SOUL.md            # "senior appsec engineer" identity
│   └── RULES.md           # hard constraints (must flag secrets as CRITICAL, etc.)
│
├── performance-reviewer/  # role: reviewer
│   ├── agent.yaml
│   ├── SOUL.md            # "staff engineer, 10yr perf optimization"
│   └── RULES.md
│
├── quality-checker/       # role: reviewer
│   ├── agent.yaml
│   ├── SOUL.md            # "principal engineer, code culture lead"
│   └── RULES.md
│
└── review-synthesizer/    # role: synthesizer (CONFLICTS with reviewer)
    ├── agent.yaml
    ├── SOUL.md            # "engineering manager, final call"
    └── DUTIES.md          # SOD declaration: cannot be reviewer
```

The root `agent.yaml` declares the conflict matrix:

```yaml
segregation_of_duties:
  conflicts:
    - [reviewer, synthesizer]   # A reviewer cannot also synthesize
    - [orchestrator, synthesizer]  # The coordinator cannot approve
  assignments:
    security-auditor: [reviewer]
    performance-reviewer: [reviewer]
    quality-checker: [reviewer]
    review-synthesizer: [synthesizer]
  enforcement: strict
```

### How GitAgent Powers the Runtime

`gitagent_loader.py` implements what `gitagent export --format system-prompt` does:

```python
class GitAgentLoader:
    def generate_system_prompt(self) -> str:
        # Concatenate: SOUL.md + RULES.md + DUTIES.md
        # This is the system prompt that gets sent to the LLM
```

Each agent's identity lives in its files — the runtime just reads them and calls Claude with the generated system prompt + the PR diff as user content.

### SkillsFlow Workflow

The review pipeline is declarative in `workflows/pr-review-flow.yaml`:

```yaml
steps:
  fetch_diff:     skill: github-fetcher
  security_review: agent: security-auditor, parallel_group: reviewers
  performance_review: agent: performance-reviewer, parallel_group: reviewers
  quality_review:  agent: quality-checker, parallel_group: reviewers
  sod_checkpoint: skill: code-analyzer, action: validate_sod
  synthesize:     agent: review-synthesizer, depends_on: [sod_checkpoint]
```

The three reviewer agents run in parallel (`parallel_group: reviewers`). The synthesizer has an explicit `depends_on: [sod_checkpoint]` — it can't run until all reviewers are done AND the SOD check passes.

### Backend (FastAPI)

```
POST /api/review         → creates job, returns job_id
GET  /api/stream/{id}    → SSE stream of agent events
GET  /api/validate-sod   → validates SOD compliance (mirrors gitagent validate --compliance)
GET  /api/agents         → lists all loaded GitAgent definitions
GET  /health             → health check
```

The SSE stream emits structured events:
```
workflow_start → fetch_complete → agent_start × 3 → tokens × N → agent_complete × 3
→ sod_checkpoint → agent_start (synthesizer) → tokens × N → agent_complete → workflow_complete
```

### Frontend (Next.js)

Real-time streaming UI with:
- Per-agent streaming text display
- Live SOD checkpoint visualization
- Expandable finding cards (severity-coded)
- Score ring + breakdown for final verdict
- Workflow stage progress indicator

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/your-username/pr-sheriff
cd pr-sheriff

# 2. Set env vars
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY

# 3. Start everything
docker compose up

# 4. Open http://localhost:3000
# 5. Paste any public GitHub PR URL and hit Review
```

### Without Docker

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

---

## GitAgent Integration

This project is fully compatible with the GitAgent CLI:

```bash
# Install gitagent
npm install -g @shreyaskapale/gitagent

# Validate all agents + SOD compliance
gitagent validate --compliance

# Export any agent to a system prompt
gitagent export agents/security-auditor --format system-prompt

# Export to Lyzr Studio
gitagent export --format lyzr

# Run with Lyzr adapter
gitagent run . --adapter lyzr

# Audit compliance
gitagent audit

# View agent info
gitagent info agents/review-synthesizer
```

---

## Why This Design

### Problem with naive LLM PR review
A single model reviewing code has three issues:
1. **No specialization** — a security-focused prompt and a quality-focused prompt compete
2. **Self-approval** — the same model that finds issues decides if the PR ships
3. **No audit trail** — you can't see which dimension caused the rejection

### How GitAgent solves it
- **Specialization**: Each agent's `SOUL.md` gives it a deep single-domain identity. The security auditor *thinks* like an AppSec engineer; it doesn't drift into style comments.
- **SOD enforcement**: The conflict matrix in `agent.yaml` makes it constitutionally impossible to conflate reviewer and synthesizer roles.
- **Audit trail**: Every agent run is a discrete event in the SSE stream. You can see exactly what each agent found, how long it took, and its confidence score.
- **Version control**: Change a reviewer's `SOUL.md` and you get a `git diff` of exactly what changed in its behavior. Roll back regressions with `git revert`.

### Why the synthesizer never sees the raw diff
The synthesizer's `DUTIES.md` declares: *"You perform NO direct code analysis — you work only from reviewer reports."*

This is an intentional constraint. The synthesizer's job is **synthesis and judgment**, not analysis. Giving it the raw diff would let it second-guess the reviewers and undermine the SOD principle.

---

## Example Output

```json
{
  "verdict": "request_changes",
  "overall_score": 61,
  "badge": "🔄 CHANGES REQUESTED",
  "summary": "The PR introduces a useful feature but has a critical N+1 query pattern in the new endpoint and a hardcoded API key in the test fixture that must be addressed before merge.",
  "breakdown": {
    "security": { "severity": "high", "score": 35, "finding_count": 1 },
    "performance": { "severity": "critical", "score": 0, "finding_count": 2 },
    "quality": { "severity": "low", "score": 80, "finding_count": 3 }
  },
  "action_items": [
    {
      "priority": "required",
      "agent": "performance-reviewer",
      "finding_id": "PERF-001",
      "description": "Fix N+1 query in UserRepository.findAll() — move query outside the loop"
    },
    {
      "priority": "required",
      "agent": "security-auditor",
      "finding_id": "SEC-001",
      "description": "Remove hardcoded API key from tests/fixtures/config.json (line 12)"
    }
  ],
  "sod_verified": true
}
```

---

## License

MIT
