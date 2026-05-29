"""
gitagent_loader.py

Reads GitAgent definitions from disk and generates system prompts,
replicating what `gitagent export --format system-prompt` does.
This is the bridge between the GitAgent standard and the LLM API.
"""

import yaml
from pathlib import Path
from typing import Optional
import json


class GitAgentLoader:
    """
    Loads a GitAgent definition from a directory and exposes
    its identity, rules, and capabilities as a system prompt.
    """

    def __init__(self, agent_path: str | Path):
        self.path = Path(agent_path)
        if not self.path.exists():
            raise FileNotFoundError(f"Agent path not found: {self.path}")

    def load_manifest(self) -> dict:
        """Load and parse agent.yaml"""
        manifest_path = self.path / "agent.yaml"
        if not manifest_path.exists():
            raise FileNotFoundError(f"agent.yaml not found in {self.path}")
        with open(manifest_path) as f:
            return yaml.safe_load(f)

    def _read_md(self, filename: str) -> Optional[str]:
        """Read a markdown file if it exists"""
        p = self.path / filename
        return p.read_text().strip() if p.exists() else None

    def generate_system_prompt(self) -> str:
        """
        Generate a concatenated system prompt from the agent's
        GitAgent definition files (SOUL.md + RULES.md + DUTIES.md).

        This mirrors `gitagent export --format system-prompt`.
        """
        parts = []

        soul = self._read_md("SOUL.md")
        if soul:
            parts.append(soul)

        rules = self._read_md("RULES.md")
        if rules:
            parts.append(f"---\n\n{rules}")

        duties = self._read_md("DUTIES.md")
        if duties:
            parts.append(f"---\n\n{duties}")

        if not parts:
            raise ValueError(f"Agent at {self.path} has no SOUL.md — invalid GitAgent definition")

        return "\n\n".join(parts)

    def get_output_schema(self) -> Optional[dict]:
        """Extract the output schema from agent.yaml if defined"""
        manifest = self.load_manifest()
        return manifest.get("output_schema")

    def get_name(self) -> str:
        manifest = self.load_manifest()
        return manifest.get("name", self.path.name)

    def get_model(self) -> str:
        manifest = self.load_manifest()
        model_config = manifest.get("model", {})
        return model_config.get("preferred", "claude-opus-4-6")

    def validate_sod(self, other_agent_roles: list[list[str]]) -> tuple[bool, str]:
        """
        Validate that this agent's roles don't conflict with other agents.
        Returns (is_valid, error_message).
        """
        manifest = self.load_manifest()
        compliance = manifest.get("compliance", {})
        sod = compliance.get("segregation_of_duties", {})
        my_roles = set(sod.get("roles", []))
        conflicts = sod.get("conflicts", [])

        for other_roles in other_agent_roles:
            other_role_set = set(other_roles)
            for conflict_pair in conflicts:
                pair_set = set(conflict_pair)
                if pair_set.issubset(my_roles | other_role_set) and \
                   my_roles & pair_set and other_role_set & pair_set:
                    return False, (
                        f"SOD violation: agent '{self.get_name()}' has role "
                        f"'{my_roles & pair_set}' which conflicts with "
                        f"role '{other_role_set & pair_set}' in another agent"
                    )
        return True, "SOD check passed"


def load_all_agents(base_path: str | Path) -> dict[str, GitAgentLoader]:
    """Load all sub-agents from the agents/ directory"""
    agents_dir = Path(base_path) / "agents"
    agents = {}
    if agents_dir.exists():
        for agent_dir in agents_dir.iterdir():
            if agent_dir.is_dir() and (agent_dir / "agent.yaml").exists():
                agents[agent_dir.name] = GitAgentLoader(agent_dir)
    return agents
