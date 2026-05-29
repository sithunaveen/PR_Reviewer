"""
agent_runner.py — GitAgent runtime layer
Uses Groq API (free tier, very fast).
Get free key at: https://console.groq.com
"""

import json
import re
import asyncio
import time
from pathlib import Path
from typing import AsyncGenerator, Optional
import httpx
from gitagent_loader import GitAgentLoader

AGENTS_BASE_PATH = Path(__file__).parent.parent / "agents"
DEFAULT_MODEL    = "llama-3.3-70b-versatile"   # Free on Groq, very capable
GROQ_URL         = "https://api.groq.com/openai/v1/chat/completions"


def truncate_text(text: str, max_chars: int = 4000) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n[... truncated ...]"


def safe_report_summary(report: dict) -> str:
    if not report:
        return "No findings reported."
    if "error" in report:
        return f"Agent error: {report['error']}"
    findings = report.get("findings", [])
    severity = report.get("severity", "unknown")
    summary  = report.get("summary", "")
    score    = report.get("score", "")
    lines    = [f"Overall severity: {severity}"]
    if score:
        lines.append(f"Score: {score}/100")
    if summary:
        lines.append(f"Summary: {summary}")
    if findings:
        lines.append(f"Top findings ({len(findings)} total):")
        for f in findings[:3]:
            lines.append(f"  [{f.get('id','')}] {str(f.get('severity','')).upper()}: {f.get('description','')}")
            if f.get("recommendation"):
                lines.append(f"    Fix: {f['recommendation']}")
    else:
        lines.append("No specific findings.")
    if "raw" in report:
        lines.append(f"Raw output: {str(report['raw'])[:400]}")
    return "\n".join(lines)


def parse_json_output(text: str) -> Optional[dict]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except json.JSONDecodeError:
            pass
    brace = re.search(r"\{[\s\S]*\}", text)
    if brace:
        try:
            return json.loads(brace.group(0))
        except json.JSONDecodeError:
            pass
    return None


async def call_groq(api_key: str, system_prompt: str, user_message: str) -> str:
    """
    Call Groq API (OpenAI-compatible format).
    verify=False fixes Windows SSL certificate errors.
    Timeout = 60s hard limit.
    """
    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "max_tokens": 2048,
        "temperature": 0.3,
    }

    async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
        response = await client.post(GROQ_URL, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise ValueError(f"Unexpected Groq response: {data}") from e


async def stream_agent(
    agent_name: str,
    user_message: str,
    api_key: str,
    system_prompt_override: Optional[str] = None,
) -> AsyncGenerator[dict, None]:

    if system_prompt_override:
        system_prompt = system_prompt_override
    else:
        agent_path = AGENTS_BASE_PATH / agent_name
        try:
            loader = GitAgentLoader(agent_path)
            system_prompt = loader.generate_system_prompt()
        except FileNotFoundError as e:
            print(f"[PR Sheriff] ERROR loading {agent_name}: {e}")
            yield {"type": "agent_error", "agent": agent_name, "error": str(e)}
            return

    print(f"[PR Sheriff] Starting {agent_name} via Groq ({DEFAULT_MODEL})")
    yield {"type": "agent_start", "agent": agent_name, "model": DEFAULT_MODEL}
    yield {"type": "token", "agent": agent_name, "text": "⏳ Analyzing with Groq..."}

    start = time.time()
    try:
        raw_text    = await call_groq(api_key, system_prompt, user_message)
        duration_ms = int((time.time() - start) * 1000)
        parsed      = parse_json_output(raw_text)
        print(f"[PR Sheriff] {agent_name} done in {duration_ms}ms | parsed={parsed is not None}")

        # Stream result in chunks so UI shows typing animation
        for i in range(0, len(raw_text), 60):
            yield {"type": "token", "agent": agent_name, "text": raw_text[i:i+60]}
            await asyncio.sleep(0)

        yield {
            "type":        "agent_complete",
            "agent":       agent_name,
            "result":      parsed or {"raw": raw_text, "parse_error": "Could not parse JSON"},
            "duration_ms": duration_ms,
        }

    except httpx.TimeoutException:
        msg = "Request timed out — check your Groq API key at console.groq.com"
        print(f"[PR Sheriff] TIMEOUT in {agent_name}")
        yield {"type": "agent_error", "agent": agent_name, "error": msg}
    except httpx.HTTPStatusError as e:
        msg = f"HTTP {e.response.status_code}: {e.response.text[:300]}"
        print(f"[PR Sheriff] HTTP ERROR in {agent_name}: {msg}")
        yield {"type": "agent_error", "agent": agent_name, "error": msg}
    except httpx.ConnectError:
        msg = "Cannot connect to Groq API — check internet connection"
        print(f"[PR Sheriff] CONNECT ERROR in {agent_name}")
        yield {"type": "agent_error", "agent": agent_name, "error": msg}
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        print(f"[PR Sheriff] ERROR in {agent_name}: {msg}")
        yield {"type": "agent_error", "agent": agent_name, "error": msg}


async def run_reviewer_agents_parallel(
    diff_content: str,
    api_key: str,
) -> AsyncGenerator[dict, None]:
    reviewer_agents = ["security-auditor", "performance-reviewer", "quality-checker"]
    truncated_diff  = truncate_text(diff_content, max_chars=4000)

    # Sequential with small delay to stay within rate limits
    for agent_name in reviewer_agents:
        async for event in stream_agent(agent_name, truncated_diff, api_key):
            yield event
        await asyncio.sleep(2)


async def run_synthesis(
    pr_metadata: dict,
    security_report: dict,
    performance_report: dict,
    quality_report: dict,
    api_key: str,
) -> AsyncGenerator[dict, None]:

    sec_text  = safe_report_summary(security_report)
    perf_text = safe_report_summary(performance_report)
    qual_text = safe_report_summary(quality_report)

    title     = pr_metadata.get("title", "Unknown PR")
    author    = pr_metadata.get("author", "unknown")
    repo      = pr_metadata.get("repo_full_name", "unknown/repo")
    additions = pr_metadata.get("additions", 0)
    deletions = pr_metadata.get("deletions", 0)
    files     = pr_metadata.get("changed_files", 0)

    system_prompt = (
        "You are a senior engineering manager issuing a final code review verdict. "
        "You receive three specialist reports and synthesize them into one verdict. "
        "Respond with ONLY a valid JSON object — no markdown fences, no explanation, "
        "no text before or after the JSON."
    )

    user_message = f"""PR: "{title}" by @{author} in {repo} (+{additions}/-{deletions} lines, {files} files)

SECURITY REPORT:
{sec_text}

PERFORMANCE REPORT:
{perf_text}

QUALITY REPORT:
{qual_text}

Return ONLY this JSON with your real values:
{{
  "verdict": "approve",
  "overall_score": 85,
  "badge": "✅ APPROVED",
  "summary": "Write 2-3 sentences summarizing the review.",
  "breakdown": {{
    "security":    {{"severity": "low",    "score": 90, "finding_count": 0}},
    "performance": {{"severity": "medium", "score": 70, "finding_count": 2}},
    "quality":     {{"severity": "low",    "score": 85, "finding_count": 1}}
  }},
  "action_items": [
    {{"priority": "required", "agent": "performance-reviewer", "finding_id": "PERF-001", "description": "Describe the fix needed"}}
  ],
  "positive_highlights": ["One good thing about this PR"],
  "sod_verified": true
}}

verdict: approve / request_changes / needs_discussion
badge: ✅ APPROVED / 🔄 CHANGES REQUESTED / 💬 NEEDS DISCUSSION / 🚨 BLOCKED"""

    print(f"[PR Sheriff] Running synthesis ({len(user_message)} chars)...")

    async for event in stream_agent(
        "review-synthesizer",
        user_message,
        api_key,
        system_prompt_override=system_prompt,
    ):
        yield event
