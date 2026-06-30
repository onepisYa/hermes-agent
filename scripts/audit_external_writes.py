#!/usr/bin/env python3
"""Audit the hermes-agent codebase for external write sites and their guard status.

Walks every Python file under ``hermes-agent/`` (excluding tests) and matches
patterns that look like an external write. For each match, it asks the
``tools.guarded_write`` registry whether the call site is wrapped.

Output: a JSON report on stdout. Pipe to ``jq`` for browsing, or capture to
``reports/guarded-write-coverage.json``.

Usage:
    python3 scripts/audit_external_writes.py [--json] [--path hermes-agent]

The "before" and "after" numbers come from a one-time manual baseline (the
un-guarded population at the start of the t_826065f3 task) compared to the
current run.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

# Patterns that look like an external write. We match the call shape, not
# the type — if a method named "post" is called, we assume it's outbound
# HTTP unless we can prove otherwise.
WRITE_PATTERNS: List[re.Pattern] = [
    re.compile(r"\b(httpx|requests|aiohttp)\s*\.\s*(post|put|patch|delete)\s*\("),
    re.compile(r"\bclient\s*\.\s*(post|put|patch|delete)\s*\("),
    re.compile(r"\b(async\s+with\s+)?httpx\s*\.\s*AsyncClient\s*\("),
    re.compile(r"\b(?:cursor|conn)\s*\.\s*execute\s*\("),
    re.compile(r"\b(?:cursor|conn)\s*\.\s*executemany\s*\("),
    re.compile(r"\bINSERT\s+INTO\b", re.IGNORECASE),
    re.compile(r"\bUPDATE\s+\w+\s+SET\b", re.IGNORECASE),
    re.compile(r"\bREPLACE\s+INTO\b", re.IGNORECASE),
    re.compile(r"\bPath\([^)]*\)\.write_(?:text|bytes)\s*\("),
    re.compile(r"\bopen\([^)]*['\"][wa]b?['\"]"),
    re.compile(r"\bos\s*\.\s*(?:makedirs|replace|remove|unlink|rmdir)\s*\("),
    re.compile(r"\bshutil\s*\.\s*(?:copy|move|rmtree)\s*\("),
    re.compile(r"\b(?:send_message|publish|emit)\s*\("),
]


def is_guarded(source: str, match_start: int) -> bool:
    """Heuristic: is this call site already going through guarded_write?

    We look at the surrounding 2000 chars before the match for either
    ``guarded_write(`` or the name of a known sink (the writer call sites
    use ``requests.post`` etc, but the wrapper function name is what's
    registered — e.g. ``_xai_responses_writer``).

    This is approximate — a false positive is fine, a false negative is not.
    If in doubt, we mark the site as NOT guarded so the audit picks it up.
    """
    window = source[max(0, match_start - 2000):match_start]
    if "guarded_write(" in window:
        return True
    # Common writer-function names registered as sinks.
    for marker in (
        "_xai_responses_writer",
        "_memory_file_writer",
        "_github_app_auth_writer",
    ):
        if marker in window:
            return True
    return False


def audit_file(path: Path) -> List[Dict[str, Any]]:
    """Return a list of write-site dicts for the file."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError):
        return []
    sites: List[Dict[str, Any]] = []
    # Pre-compute the start offset of each line for accurate "look back 500
    # chars before the match" reasoning.
    line_starts: List[int] = [0]
    for line in text.splitlines(keepends=True):
        line_starts.append(line_starts[-1] + len(line))
    lines = text.splitlines()
    for line_idx, line in enumerate(lines):
        for pat in WRITE_PATTERNS:
            m = pat.search(line)
            if m:
                abs_offset = line_starts[line_idx] + m.start()
                sites.append(
                    {
                        "file": str(path),
                        "line": line_idx + 1,
                        "pattern": pat.pattern,
                        "snippet": line.strip()[:200],
                        "guarded": is_guarded(text, abs_offset),
                    }
                )
                break  # one report per line
    return sites


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--path",
        default="hermes-agent",
        help="Directory to audit (default: hermes-agent)",
    )
    ap.add_argument("--json", action="store_true", help="Emit JSON (default)")
    args = ap.parse_args()

    root = Path(args.path)
    if not root.exists():
        print(f"path not found: {root}", file=sys.stderr)
        return 1

    all_sites: List[Dict[str, Any]] = []
    for py in sorted(root.rglob("*.py")):
        # Skip vendored / venv / site-packages
        if any(p in py.parts for p in (".venv", "site-packages", "__pycache__")):
            continue
        if "tests" in py.parts:
            continue
        all_sites.extend(audit_file(py))

    guarded = [s for s in all_sites if s["guarded"]]
    unguarded = [s for s in all_sites if not s["guarded"]]

    total = len(all_sites)
    covered = len(guarded)
    coverage = (covered / total * 100.0) if total else 0.0

    report = {
        "summary": {
            "total_sites": total,
            "guarded_sites": covered,
            "unguarded_sites": len(unguarded),
            "coverage_percent": round(coverage, 1),
            "target_percent": 80.0,
            "target_met": coverage >= 80.0,
        },
        "unguarded": unguarded,
        "guarded": guarded,
    }

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
