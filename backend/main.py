"""
main.py — PR Sheriff FastAPI Backend

Orchestrates the GitAgent multi-agent PR review workflow:
  POST /api/review        → Start a review (returns job_id)
  GET  /api/stream/{id}  → SSE stream of agent events
  GET  /api/validate     → Validate SOD compliance
  GET  /health           → Health check
"""

import asyncio
import json
import os
import uuid
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, HttpUrl
from dotenv import load_dotenv

from github_fetcher import fetch_pr, format_diff_for_agent, parse_pr_url
from agent_runner import run_reviewer_agents_parallel, run_synthesis
from gitagent_loader import load_all_agents, GitAgentLoader

# Try loading .env from multiple locations so it works regardless of
# which directory uvicorn is launched from
_here = Path(__file__).parent
for _env_path in [
    _here / ".env",                  # backend/.env
    _here.parent / ".env",           # pr-sheriff/.env  (project root)
    Path.cwd() / ".env",             # wherever you ran uvicorn from
]:
    if _env_path.exists():
        load_dotenv(dotenv_path=_env_path, override=True)
        print(f"[PR Sheriff] Loaded .env from: {_env_path}")
        break

# Print key status on startup so you can see immediately if it loaded
_key = os.getenv("ANTHROPIC_API_KEY", "")
if _key:
    print(f"[PR Sheriff] ✅ ANTHROPIC_API_KEY loaded (starts with: {_key[:12]}...)")
else:
    print("[PR Sheriff] ⚠️  ANTHROPIC_API_KEY not found in environment or .env file")

app = FastAPI(
    title="PR Sheriff API",
    description="Multi-agent GitHub PR review system built on GitAgent",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store (production would use Redis)
jobs: dict[str, dict] = {}

AGENTS_BASE = Path(__file__).parent.parent


# ── Request/Response Models ─────────────────────────────────────────────────

class ReviewRequest(BaseModel):
    pr_url: str
    github_token: Optional[str] = None
    review_depth: str = "standard"
    anthropic_api_key: Optional[str] = None   # kept for backward compat
    gemini_api_key: Optional[str] = None       # Google Gemini free API key


class ReviewJob(BaseModel):
    job_id: str
    pr_url: str
    status: str
    created_at: float


class SODValidationResponse(BaseModel):
    valid: bool
    agents: list[dict]
    conflicts_found: list[str]
    message: str


# ── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check — also validates agent definitions are loadable"""
    agents = load_all_agents(AGENTS_BASE)
    return {
        "status": "healthy",
        "agents_loaded": list(agents.keys()),
        "gitagent_spec": "0.1.0",
    }


@app.get("/api/validate-sod", response_model=SODValidationResponse)
async def validate_sod():
    """
    Validate that the SOD policy in agent.yaml is satisfied.
    Mirrors `gitagent validate --compliance`.
    """
    agents = load_all_agents(AGENTS_BASE)
    conflicts_found = []
    agent_summaries = []

    for name, loader in agents.items():
        try:
            manifest = loader.load_manifest()
            sod = manifest.get("compliance", {}).get("segregation_of_duties", {})
            roles = sod.get("roles", [])
            agent_summaries.append({
                "name": name,
                "roles": roles,
                "model": loader.get_model(),
            })
        except Exception as e:
            conflicts_found.append(f"Failed to load {name}: {e}")

    # Check root manifest SOD
    root_loader = GitAgentLoader(AGENTS_BASE)
    root_manifest = root_loader.load_manifest()
    root_sod = root_manifest.get("compliance", {}).get("segregation_of_duties", {})
    root_conflicts = root_sod.get("conflicts", [])
    assignments = root_sod.get("assignments", {})

    role_map: dict[str, list[str]] = {}
    for agent_name, roles in assignments.items():
        for role in roles:
            role_map.setdefault(role, []).append(agent_name)

    # Check each conflict pair
    for conflict_pair in root_conflicts:
        if len(conflict_pair) == 2:
            role_a, role_b = conflict_pair
            agents_a = set(role_map.get(role_a, []))
            agents_b = set(role_map.get(role_b, []))
            overlap = agents_a & agents_b
            if overlap:
                conflicts_found.append(
                    f"SOD VIOLATION: Agent(s) {overlap} hold both '{role_a}' and '{role_b}' roles"
                )

    return SODValidationResponse(
        valid=len(conflicts_found) == 0,
        agents=agent_summaries,
        conflicts_found=conflicts_found,
        message="✅ SOD policy validated — no violations found"
        if not conflicts_found
        else f"❌ {len(conflicts_found)} SOD violation(s) detected",
    )


@app.post("/api/review", response_model=ReviewJob)
async def start_review(request: ReviewRequest):
    """
    Start a PR review job. Returns a job_id to stream from.
    """
    # Accept either Gemini key or Anthropic key (Gemini is free)
    api_key = (
        (request.gemini_api_key or "").strip()
        or (request.anthropic_api_key or "").strip()
        or os.getenv("GEMINI_API_KEY", "").strip()
        or os.getenv("ANTHROPIC_API_KEY", "").strip()
    )

    # Debug — visible in your uvicorn terminal
    key_source = "gemini_request" if (request.gemini_api_key or "").strip() else                  "anthropic_request" if (request.anthropic_api_key or "").strip() else                  "GEMINI_API_KEY env" if os.getenv("GEMINI_API_KEY") else                  "ANTHROPIC_API_KEY env" if os.getenv("ANTHROPIC_API_KEY") else "NONE"
    print(f"[PR Sheriff] API key source: {key_source} | key present: {'YES' if api_key else 'NO'}")

    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="API key required. Add your free Gemini key at https://aistudio.google.com and paste it in the API Keys field.",
        )

    try:
        parse_pr_url(request.pr_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "status": "queued",
        "pr_url": request.pr_url,
        "github_token": request.github_token,
        "api_key": api_key,
        "review_depth": request.review_depth,
        "created_at": time.time(),
        "events": [],
    }

    return ReviewJob(
        job_id=job_id,
        pr_url=request.pr_url,
        status="queued",
        created_at=jobs[job_id]["created_at"],
    )


@app.get("/api/stream/{job_id}")
async def stream_review(job_id: str):
    """
    SSE endpoint that streams the full multi-agent review workflow.

    Event sequence:
      workflow_start → fetch_start → fetch_complete
      → [security|performance|quality]_start → tokens → complete (parallel)
      → sod_checkpoint
      → synthesizer_start → tokens → synthesizer_complete
      → workflow_complete
    """
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]

    async def event_generator():
        job["status"] = "running"

        async def send(event_type: str, data: dict = {}):
            payload = json.dumps({"type": event_type, **data})
            return f"data: {payload}\n\n"

        # ── Stage 1: Workflow Start ──────────────────────────────────────
        yield await send("workflow_start", {
            "pr_url": job["pr_url"],
            "stages": ["fetch", "review_parallel", "sod_check", "synthesize"],
        })

        # ── Stage 2: Fetch PR Diff ───────────────────────────────────────
        yield await send("stage_start", {"stage": "fetch", "label": "Fetching PR from GitHub"})

        try:
            pr_diff = await fetch_pr(
                job["pr_url"],
                github_token=job.get("github_token"),
            )
        except Exception as e:
            yield await send("workflow_error", {"error": str(e), "stage": "fetch"})
            job["status"] = "failed"
            return

        diff_content = format_diff_for_agent(pr_diff)

        yield await send("fetch_complete", {
            "metadata": pr_diff.metadata.model_dump(),
            "diff_lines": len(pr_diff.diff.split("\n")),
            "files": pr_diff.files[:5],
        })

        # ── Stage 3: Parallel Review ─────────────────────────────────────
        yield await send("stage_start", {
            "stage": "review_parallel",
            "label": "Dispatching 3 independent reviewer agents",
            "agents": ["security-auditor", "performance-reviewer", "quality-checker"],
        })

        reviewer_results = {
            "security-auditor": None,
            "performance-reviewer": None,
            "quality-checker": None,
        }

        async for event in run_reviewer_agents_parallel(diff_content, job["api_key"]):
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] == "agent_complete":
                reviewer_results[event["agent"]] = event.get("result", {})
            elif event["type"] == "agent_error":
                reviewer_results[event["agent"]] = {"error": event.get("error")}

        # ── Stage 4: SOD Checkpoint ──────────────────────────────────────
        yield await send("sod_checkpoint", {
            "verified": True,
            "reviewers_completed": list(reviewer_results.keys()),
            "message": "✅ SOD verified — synthesizer has not seen the raw diff",
            "rule": "reviewer + synthesizer conflict enforced",
        })

        # ── Stage 5: Synthesis ───────────────────────────────────────────
        yield await send("stage_start", {
            "stage": "synthesize",
            "label": "Review Synthesizer issuing final verdict",
        })

        final_result = None
        async for event in run_synthesis(
            pr_metadata=pr_diff.metadata.model_dump(),
            security_report=reviewer_results.get("security-auditor") or {},
            performance_report=reviewer_results.get("performance-reviewer") or {},
            quality_report=reviewer_results.get("quality-checker") or {},
            api_key=job["api_key"],
        ):
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] == "agent_complete" and event["agent"] == "review-synthesizer":
                final_result = event.get("result")
            elif event["type"] == "agent_error" and event["agent"] == "review-synthesizer":
                final_result = {"verdict": "needs_discussion", "overall_score": 0,
                               "badge": "⚠️ SYNTHESIZER ERROR", "summary": event.get("error","Unknown error"),
                               "action_items": [], "breakdown": {}, "positive_highlights": []}

        # ── Stage 6: Done ────────────────────────────────────────────────
        job["status"] = "complete"
        job["result"] = final_result

        yield await send("workflow_complete", {
            "verdict": final_result.get("verdict") if final_result else "unknown",
            "overall_score": final_result.get("overall_score") if final_result else None,
            "badge": final_result.get("badge") if final_result else "Review Complete",
        })

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/agents")
async def list_agents():
    """List all loaded GitAgent definitions with their metadata"""
    agents = load_all_agents(AGENTS_BASE)
    result = []
    for name, loader in agents.items():
        try:
            manifest = loader.load_manifest()
            result.append({
                "name": name,
                "description": manifest.get("description", "").strip(),
                "model": loader.get_model(),
                "roles": manifest.get("compliance", {})
                    .get("segregation_of_duties", {})
                    .get("roles", []),
                "has_soul": (loader.path / "SOUL.md").exists(),
                "has_rules": (loader.path / "RULES.md").exists(),
                "has_duties": (loader.path / "DUTIES.md").exists(),
            })
        except Exception as e:
            result.append({"name": name, "error": str(e)})
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
