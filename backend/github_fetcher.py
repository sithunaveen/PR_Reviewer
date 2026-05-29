"""
github_fetcher.py

Fetches PR metadata and unified diff from the GitHub API.
Corresponds to the github-fetcher skill in the GitAgent definition.
"""

import httpx
import re
from typing import Optional
from pydantic import BaseModel


class PRMetadata(BaseModel):
    number: int
    title: str
    author: str
    base_branch: str
    head_branch: str
    repo_full_name: str
    url: str
    additions: int
    deletions: int
    changed_files: int
    body: Optional[str] = None
    labels: list[str] = []


class PRDiff(BaseModel):
    metadata: PRMetadata
    diff: str
    files: list[dict] = []


def parse_pr_url(url: str) -> tuple[str, str, int]:
    """
    Parse GitHub PR URL into (owner, repo, pr_number).
    Supports:
      https://github.com/owner/repo/pull/42
      github.com/owner/repo/pull/42
    """
    pattern = r"(?:https?://)?github\.com/([^/]+)/([^/]+)/pull/(\d+)"
    match = re.search(pattern, url)
    if not match:
        raise ValueError(
            f"Invalid GitHub PR URL: {url}\n"
            "Expected format: https://github.com/owner/repo/pull/42"
        )
    owner, repo, number = match.groups()
    return owner, repo, int(number)


async def fetch_pr(
    pr_url: str,
    github_token: Optional[str] = None,
    max_diff_lines: int = 5000,
) -> PRDiff:
    """
    Fetch PR metadata and diff from GitHub API.
    Works for public repos without a token; private repos require one.
    """
    owner, repo, pr_number = parse_pr_url(pr_url)

    headers = {
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if github_token:
        headers["Authorization"] = f"Bearer {github_token}"

    base_url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}"

    async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
        # Fetch PR metadata
        meta_resp = await client.get(base_url, headers=headers)
        if meta_resp.status_code == 404:
            raise ValueError(f"PR not found: {pr_url} (may be private — provide a GitHub token)")
        meta_resp.raise_for_status()
        meta = meta_resp.json()

        # Fetch unified diff
        diff_headers = {**headers, "Accept": "application/vnd.github.v3.diff"}
        diff_resp = await client.get(base_url, headers=diff_headers)
        diff_resp.raise_for_status()
        diff_text = diff_resp.text

        # Fetch changed files list
        files_resp = await client.get(f"{base_url}/files", headers=headers)
        files_resp.raise_for_status()
        files = files_resp.json()

    # Truncate diff if too large
    diff_lines = diff_text.split("\n")
    truncated = False
    if len(diff_lines) > max_diff_lines:
        diff_text = "\n".join(diff_lines[:max_diff_lines])
        diff_text += f"\n\n[DIFF TRUNCATED — showing first {max_diff_lines} lines of {len(diff_lines)} total]"
        truncated = True

    metadata = PRMetadata(
        number=meta["number"],
        title=meta["title"],
        author=meta["user"]["login"],
        base_branch=meta["base"]["ref"],
        head_branch=meta["head"]["ref"],
        repo_full_name=f"{owner}/{repo}",
        url=pr_url,
        additions=meta["additions"],
        deletions=meta["deletions"],
        changed_files=meta["changed_files"],
        body=meta.get("body") or "",
        labels=[label["name"] for label in meta.get("labels", [])],
    )

    return PRDiff(
        metadata=metadata,
        diff=diff_text,
        files=[
            {
                "filename": f["filename"],
                "status": f["status"],
                "additions": f["additions"],
                "deletions": f["deletions"],
                "patch": f.get("patch", "")[:500],  # First 500 chars of each file patch
            }
            for f in files[:20]  # Cap at 20 files in summary
        ],
    )


def format_diff_for_agent(pr_diff: PRDiff) -> str:
    """
    Format PR data into a structured prompt for agent analysis.
    """
    meta = pr_diff.metadata
    return f"""## Pull Request: #{meta.number} — {meta.title}

**Repository:** {meta.repo_full_name}
**Author:** @{meta.author}
**Base:** `{meta.base_branch}` ← `{meta.head_branch}`
**Changes:** +{meta.additions} lines / -{meta.deletions} lines across {meta.changed_files} files
**Labels:** {", ".join(meta.labels) if meta.labels else "none"}

**PR Description:**
{meta.body or "(no description provided)"}

---

## Files Changed

{chr(10).join(f"- `{f['filename']}` ({f['status']}, +{f['additions']}/-{f['deletions']})" for f in pr_diff.files)}

---

## Unified Diff

```diff
{pr_diff.diff}
```
"""
