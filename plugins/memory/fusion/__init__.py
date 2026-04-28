"""Fusion memory plugin — multi-backend RRF fusion.

Calls Hindsight recall, qmd search, and SessionDB search in parallel,
then fuses results with second-level Reciprocal Rank Fusion (RRF).

Config via environment variables / config.json:
  FUSION_RRF_K           — RRF k parameter (default: 60)
  FUSION_HINDSIGHT_BOOST — Hindsight boost weight (default: 1.1)
  QMD_API_URL            — qmd MCP HTTP URL (default: http://localhost:8181)

Registration: set memory.provider: fusion in config.yaml.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)

_RRF_K = int(os.environ.get("FUSION_RRF_K", "60"))
_HINDSIGHT_BOOST = float(os.environ.get("FUSION_HINDSIGHT_BOOST", "1.1"))
_QMD_URL = os.environ.get("QMD_API_URL", "http://localhost:8181")

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class FusedItem:
    source: str  # "hindsight" | "qmd" | "sessiondb"
    text: str
    original_rank: int
    score: float
    metadata: dict = field(default_factory=dict)
    rrf_score: float = 0.0


# ---------------------------------------------------------------------------
# Per-backend result types
# ---------------------------------------------------------------------------

HindsightResult = List[Dict[str, Any]]  # [{text, score, ...}]
QmdResult = List[Dict[str, Any]]  # [{content, score, ...}]
SessionDBResult = List[Dict[str, Any]]  # [{id, session_id, snippet, ...}]


# ---------------------------------------------------------------------------
# SessionDB singleton access
# ---------------------------------------------------------------------------

_session_db_instance: Optional[Any] = None
_session_db_lock = threading.Lock()


def _get_session_db():
    """Return the process-wide SessionDB singleton."""
    global _session_db_instance
    if _session_db_instance is None:
        with _session_db_lock:
            if _session_db_instance is None:
                # Import here to avoid circular dependencies
                try:
                    from hermes_state import SessionDB

                    _session_db_instance = SessionDB()
                    logger.info("Fusion: SessionDB singleton initialized")
                except Exception as e:
                    logger.warning("Fusion: SessionDB init failed: %s", e)
                    return None
    return _session_db_instance


# ---------------------------------------------------------------------------
# qmd CLI client (subprocess on background thread)
# ---------------------------------------------------------------------------


def _qmd_query(query: str, limit: int = 10) -> QmdResult:
    """Call qmd CLI via subprocess. Runs on background thread (called from async)."""
    import re
    import subprocess

    try:
        # Use 'qmd search' for simpler BM25-only output (no LLM expansion needed)
        result = subprocess.run(
            ["qmd", "search", query],
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout + result.stderr

        # Parse qmd structured output
        # Format: qmd://path:line #hash\nTitle: ...\nScore: ...%\n\n@@ ...\ncontent...
        entries = []
        current = {}
        in_content = False

        for line in output.split("\n"):
            ls = line.strip()
            if ls.startswith("qmd://"):
                if current and current.get("path"):
                    entries.append(current)
                hash_part = ls.rsplit(" #", 1) if " #" in ls else (ls, "")
                path_part = hash_part[0].replace("qmd://", "")
                current = {"path": path_part, "hash": hash_part[1] if len(hash_part) > 1 else "", "content": ""}
                in_content = False
            elif ls.startswith("Score:"):
                m = re.search(r"(\d+)%", ls)
                current["score"] = int(m.group(1)) / 100 if m else 0.0
            elif ls.startswith("@@ "):
                in_content = True
            elif ls == "":
                in_content = False
            elif current.get("score") is not None and in_content:
                current["content"] += ls + " "

        if current and current.get("path"):
            entries.append(current)

        return [
            {
                "text": e.get("content", "").strip() or e.get("path", ""),
                "score": e.get("score", 0.0),
                "metadata": {"source": "qmd", "path": e.get("path", ""), "hash": e.get("hash", "")},
            }
            for e in entries[:limit]
            if e.get("content", "").strip()
        ]
    except Exception as e:
        logger.warning("Fusion qmd query failed: %s", e)
        return []


# ---------------------------------------------------------------------------
# Hindsight recall (async, via executor)
# ---------------------------------------------------------------------------


def _hindsight_recall(query: str, bank_id: str = "hermes", budget: str = "mid", limit: int = 10) -> HindsightResult:
    """Call Hindsight recall on background thread (cloud via hindsight_client, local via hindsight)."""
    import os
    import subprocess
    from pathlib import Path

    try:
        # Load config — check both locations
        cfg = {}
        for config_path in [
            Path.home() / ".hermes" / "hindsight" / "config.json",
            Path.home() / ".hindsight" / "config.json",
        ]:
            if config_path.exists():
                cfg = json.loads(config_path.read_text(encoding="utf-8"))
                break

        mode = cfg.get("mode", os.environ.get("HINDSIGHT_MODE", "cloud"))
        api_key = cfg.get("apiKey") or cfg.get("api_key") or os.environ.get("HINDSIGHT_API_KEY", "")
        api_url = cfg.get("api_url") or os.environ.get("HINDSIGHT_API_URL", "")

        if mode == "local_embedded":
            # Check if hindsight-embed server is running (ports 9177 / 19177)
            for port in [9177, 19177]:
                check = subprocess.run(
                    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                     f"http://localhost:{port}/health"],
                    capture_output=True, text=True, timeout=5,
                )
                if check.stdout.strip() == "200":
                    break
            else:
                logger.warning("Fusion: hindsight-embed server not reachable on 9117/19177")
                return []

            from hindsight import HindsightEmbedded

            llm_provider = cfg.get("llm_provider", "minimax")
            if llm_provider in ("openai_compatible", "openrouter"):
                llm_provider = "minimax"  # use minimax for local embedded
            client = HindsightEmbedded(
                profile=bank_id,
                llm_provider=llm_provider,
                llm_api_key=cfg.get("llmApiKey") or cfg.get("llm_api_key") or os.environ.get("HINDSIGHT_LLM_API_KEY", ""),
                llm_base_url=cfg.get("llm_base_url") or os.environ.get("HINDSIGHT_API_LLM_BASE_URL", ""),
            )
            resp = asyncio.run(client.arecall(bank_id=bank_id, query=query, budget=budget, max_tokens=4096))
        else:
            # Cloud mode — use hindsight_client
            from hindsight_client import Hindsight

            if not api_url:
                api_url = "https://api.hindsight.vectorize.io"
            client = Hindsight(base_url=api_url, api_key=api_key)
            resp = asyncio.run(client.arecall(bank_id=bank_id, query=query, budget=budget, max_tokens=4096))

        return [
            {
                "text": r.text,
                "score": getattr(r, "score", 0.0),
                "metadata": {"source": "hindsight"},
            }
            for r in (resp.results or [])[:limit]
        ]
    except Exception as e:
        logger.warning("Fusion hindsight_recall failed: %s", e)
        return []


def _hindsight_retain(
    content: str,
    bank_id: str = "hermes",
    context: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> str:
    """Store content to Hindsight long-term memory. Runs on background thread."""
    import os
    from pathlib import Path

    try:
        cfg = {}
        for config_path in [
            Path.home() / ".hermes" / "hindsight" / "config.json",
            Path.home() / ".hindsight" / "config.json",
        ]:
            if config_path.exists():
                cfg = json.loads(config_path.read_text(encoding="utf-8"))
                break

        mode = cfg.get("mode", os.environ.get("HINDSIGHT_MODE", "cloud"))
        api_key = cfg.get("apiKey") or cfg.get("api_key") or os.environ.get("HINDSIGHT_API_KEY", "")

        if mode == "local_embedded":
            for port in [9177, 19177]:
                check_result = __import__("subprocess").run(
                    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                     f"http://localhost:{port}/health"],
                    capture_output=True, text=True, timeout=5,
                )
                if check_result.stdout.strip() == "200":
                    break
            else:
                raise RuntimeError("Hindsight embedded server not reachable on 9177/19177")

            from hindsight import HindsightEmbedded

            client = HindsightEmbedded(
                profile=bank_id,
                llm_provider=cfg.get("llm_provider", "minimax"),
                llm_api_key=cfg.get("llmApiKey") or cfg.get("llm_api_key") or os.environ.get("HINDSIGHT_LLM_API_KEY", ""),
                llm_base_url=cfg.get("llm_base_url") or os.environ.get("HINDSIGHT_API_LLM_BASE_URL", ""),
            )
            asyncio.run(client.aretain(
                bank_id=bank_id,
                content=content,
                context=context,
                tags=tags,
            ))
        else:
            from hindsight_client import Hindsight

            api_url = cfg.get("api_url") or os.environ.get("HINDSIGHT_API_URL", "https://api.hindsight.vectorize.io")
            client = Hindsight(base_url=api_url, api_key=api_key)
            asyncio.run(client.aretain(
                bank_id=bank_id,
                content=content,
                context=context,
                tags=tags,
            ))

        return "Memory stored successfully in Hindsight."
    except Exception as e:
        logger.warning("Fusion hindsight_retain failed: %s", e)
        raise


def _hindsight_reflect(
    query: str,
    bank_id: str = "hermes",
    budget: str = "mid",
) -> str:
    """Synthesize a reasoned answer from Hindsight memories. Runs on background thread."""
    import os
    from pathlib import Path

    try:
        cfg = {}
        for config_path in [
            Path.home() / ".hermes" / "hindsight" / "config.json",
            Path.home() / ".hindsight" / "config.json",
        ]:
            if config_path.exists():
                cfg = json.loads(config_path.read_text(encoding="utf-8"))
                break

        mode = cfg.get("mode", os.environ.get("HINDSIGHT_MODE", "cloud"))
        api_key = cfg.get("apiKey") or cfg.get("api_key") or os.environ.get("HINDSIGHT_API_KEY", "")

        if mode == "local_embedded":
            for port in [9177, 19177]:
                check_result = __import__("subprocess").run(
                    ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                     f"http://localhost:{port}/health"],
                    capture_output=True, text=True, timeout=5,
                )
                if check_result.stdout.strip() == "200":
                    break
            else:
                raise RuntimeError("Hindsight embedded server not reachable on 9177/19177")

            from hindsight import HindsightEmbedded

            client = HindsightEmbedded(
                profile=bank_id,
                llm_provider=cfg.get("llm_provider", "minimax"),
                llm_api_key=cfg.get("llmApiKey") or cfg.get("llm_api_key") or os.environ.get("HINDSIGHT_LLM_API_KEY", ""),
                llm_base_url=cfg.get("llm_base_url") or os.environ.get("HINDSIGHT_API_LLM_BASE_URL", ""),
            )
            resp = asyncio.run(client.areflect(bank_id=bank_id, query=query, budget=budget))
        else:
            from hindsight_client import Hindsight

            api_url = cfg.get("api_url") or os.environ.get("HINDSIGHT_API_URL", "https://api.hindsight.vectorize.io")
            client = Hindsight(base_url=api_url, api_key=api_key)
            resp = asyncio.run(client.areflect(bank_id=bank_id, query=query, budget=budget))

        return resp.text or "No reflection generated."
    except Exception as e:
        logger.warning("Fusion hindsight_reflect failed: %s", e)
        raise


# ---------------------------------------------------------------------------
# RRF Fusion
# ---------------------------------------------------------------------------


def rrf_fuse(items: List[FusedItem], k: int = _RRF_K) -> List[FusedItem]:
    """Second-level RRF fusion of multi-source results."""
    score_map: Dict[str, float] = {}
    key_map: Dict[str, FusedItem] = {}

    for item in items:
        key = item.text[:100]  # approximate dedup by prefix
        rrf = 1.0 / (k + item.original_rank)
        weight = _HINDSIGHT_BOOST if item.source == "hindsight" else 1.0
        score_map[key] = score_map.get(key, 0.0) + rrf * weight
        if key not in key_map:
            key_map[key] = item

    sorted_keys = sorted(score_map, key=score_map.get, reverse=True)
    result = []
    for rank, key in enumerate(sorted_keys, 1):
        item = key_map[key]
        item.rrf_score = score_map[key]
        item.metadata["final_rank"] = rank
        item.metadata["fused_sources"] = [it.source for it in items if it.text[:100] == key]
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# FusionMemoryProvider
# ---------------------------------------------------------------------------


class FusionMemoryProvider(MemoryProvider):
    """Fuses Hindsight + qmd + SessionDB via second-level RRF."""

    def __init__(self) -> None:
        self._session_id: str = ""
        self._hindsight_bank: str = os.environ.get("HINDSIGHT_BANK_ID", "hermes")
        self._hindsight_budget: str = os.environ.get("HINDSIGHT_BUDGET", "mid")
        self._hindsight_client: Optional[Any] = None
        self._initialized: bool = False
        self._agent_identity: str = ""

    # -- MemoryProvider ABC ----------------------------------------------------

    @property
    def name(self) -> str:
        return "fusion"

    def is_available(self) -> bool:
        """Fusion is available if at least one backend is reachable."""
        # Check qmd HTTP
        try:
            import urllib.request

            req = urllib.request.Request(
                f"{_QMD_URL}/status",
                method="GET",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=5)
            qmd_ok = True
        except Exception:
            qmd_ok = False

        # Check Hindsight config — check both possible locations
        try:
            from pathlib import Path

            hindsight_cfg_ok = False
            for config_path in [
                Path.home() / ".hermes" / "hindsight" / "config.json",
                Path.home() / ".hindsight" / "config.json",
            ]:
                if config_path.exists():
                    hindsight_cfg_ok = True
                    break
        except Exception:
            hindsight_cfg_ok = False

        # SessionDB always available (no network check needed)
        sessiondb_ok = True

        available = qmd_ok or hindsight_cfg_ok or sessiondb_ok
        logger.info(
            "FusionMemoryProvider.is_available: qmd=%s, hindsight=%s, sessiondb=%s → %s",
            qmd_ok,
            hindsight_cfg_ok,
            sessiondb_ok,
            available,
        )
        return available

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id
        self._agent_identity = kwargs.get("agent_identity", "")
        self._hindsight_bank = os.environ.get("HINDSIGHT_BANK_ID", "hermes")
        self._hindsight_budget = os.environ.get("HINDSIGHT_BUDGET", "mid")
        self._initialized = True
        logger.info("FusionMemoryProvider initialized for session=%s", session_id)

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Sync to all backends. Runs independently, non-blocking."""
        if not self._initialized:
            return

        def _bg_sync():
            try:
                self._sync_hindsight(user_content, assistant_content)
            except Exception as e:
                logger.debug("Fusion hindsight sync failed (non-fatal): %s", e)
            try:
                self._sync_sessiondb(user_content, assistant_content, session_id)
            except Exception as e:
                logger.debug("Fusion sessiondb sync failed (non-fatal): %s", e)

        t = threading.Thread(target=_bg_sync, daemon=True, name="fusion-sync")
        t.start()

    def _sync_hindsight(self, user_content: str, assistant_content: str) -> None:
        """Retain turn to Hindsight."""
        try:
            from pathlib import Path

            # Check both possible config locations (hermes profile vs raw .hindsight)
            cfg = {}
            for config_path in [
                Path.home() / ".hermes" / "hindsight" / "config.json",
                Path.home() / ".hindsight" / "config.json",
            ]:
                if config_path.exists():
                    cfg = json.loads(config_path.read_text(encoding="utf-8"))
                    break

            api_key = cfg.get("apiKey") or cfg.get("api_key") or os.environ.get("HINDSIGHT_API_KEY", "")
            api_url = cfg.get("api_url") or os.environ.get("HINDSIGHT_API_URL", "")
            mode = cfg.get("mode", os.environ.get("HINDSIGHT_MODE", "cloud"))

            if mode == "local_embedded":
                import site
                # Prepend venv site-packages so hindsight.embedded resolves from venv,
                # not from plugins/memory/hindsight/ (which shadows the real hindsight package)
                venv_site = site.getsitepackages()[0]
                import sys
                # Remove any existing venv entries and re-insert at position 0
                while venv_site in sys.path:
                    sys.path.remove(venv_site)
                sys.path.insert(0, venv_site)
                # Remove plugin's hindsight from sys.modules so re-import finds venv version
                for _k in list(sys.modules.keys()):
                    if _k == "hindsight" or _k.startswith("hindsight."):
                        del sys.modules[_k]
                from hindsight.embedded import HindsightEmbedded

                llm_provider = cfg.get("llm_provider", "minimax")
                if llm_provider in ("openai_compatible", "openrouter"):
                    llm_provider = "minimax"
                client: Any = HindsightEmbedded(
                    profile=self._hindsight_bank,
                    llm_provider=llm_provider,
                    llm_api_key=cfg.get("llmApiKey") or cfg.get("llm_api_key") or os.environ.get("HINDSIGHT_LLM_API_KEY", ""),
                    llm_base_url=cfg.get("llm_base_url") or os.environ.get("HINDSIGHT_API_LLM_BASE_URL", ""),
                )
            else:
                import site
                venv_site = site.getsitepackages()[0]
                import sys
                while venv_site in sys.path:
                    sys.path.remove(venv_site)
                sys.path.insert(0, venv_site)
                for _k in list(sys.modules.keys()):
                    if _k == "hindsight" or _k.startswith("hindsight."):
                        del sys.modules[_k]
                from hindsight import HindsightClient

                client = HindsightClient(base_url=api_url or None, api_key=api_key or None)

            asyncio.run(client.aretain(
                bank_id=self._hindsight_bank,
                content=f"User: {user_content}\nAssistant: {assistant_content}",
                context="conversation turn",
            ))
            logger.info("Fusion hindsight retain succeeded for session=%s", self._session_id)
            logger.debug("sys.path[0] in background thread: %s", sys.path[0])
        except Exception as e:
            logger.warning("Fusion hindsight retain failed: %s", e)

    def _sync_sessiondb(self, user_content: str, assistant_content: str, session_id: str) -> None:
        """Insert turn into SessionDB."""
        db = _get_session_db()
        if db is None:
            return
        try:
            db.insert_message(session_id or self._session_id, "user", user_content)
            db.insert_message(session_id or self._session_id, "assistant", assistant_content)
        except Exception as e:
            logger.debug("Fusion sessiondb insert failed: %s", e)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            # ---- Fusion (best overall recall) ----
            {
                "name": "fusion_recall",
                "description": (
                    "Search across Hindsight (semantic+BM25+entity graph), "
                    "qmd (BM25+vector), and SessionDB (FTS5) in parallel, "
                    "then fuse results with second-level Reciprocal Rank Fusion (RRF). "
                    "Use when you need the best recall from all memory sources."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "What to search for.",
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Max results per backend (default: 10).",
                            "default": 10,
                        },
                    },
                    "required": ["query"],
                },
            },
            # ---- Hindsight native tools (exposed directly — use when you need specific capability) ----
            {
                "name": "hindsight_retain",
                "description": (
                    "Store information to long-term memory. Hindsight automatically "
                    "extracts structured facts, resolves entities, and indexes for retrieval. "
                    "Use when you want to explicitly save something to Hindsight."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The information to store."},
                        "context": {"type": "string", "description": "Short label (e.g. 'user preference', 'project decision')."},
                        "tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Optional per-call tags.",
                        },
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "hindsight_recall",
                "description": (
                    "Search long-term memory via Hindsight's 4-way RRF "
                    "(semantic + BM25 + entity graph + reranking). "
                    "Best for entity/fact queries and cross-session synthesis. "
                    "Use instead of fusion_recall when you specifically need Hindsight."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for."},
                        "limit": {"type": "integer", "description": "Max results (default: 10).", "default": 10},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "hindsight_reflect",
                "description": (
                    "Synthesize a reasoned answer from long-term memories via Hindsight Reflect. "
                    "Unlike recall, this reasons across all stored memories to produce a coherent response. "
                    "Use when you need deep synthesis, not just retrieval."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The question to reflect on."},
                    },
                    "required": ["query"],
                },
            },
            # ---- SessionDB verbatim search (exact keyword match) ----
            {
                "name": "sessiondb_search",
                "description": (
                    "Search Hermes session history via SQLite FTS5 verbatim match. "
                    "Best for exact keyword/phrase matches in past conversations. "
                    "Use when fusion_recall or hindsight_recall misses something "
                    "and you suspect it exists in session history."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Keywords to search for verbatim."},
                        "limit": {"type": "integer", "description": "Max results (default: 10).", "default": 10},
                    },
                    "required": ["query"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        # ---- fusion_recall ----
        if tool_name == "fusion_recall":
            query = args.get("query", "")
            if not query:
                return tool_error("Missing required parameter: query")
            limit = args.get("limit", 10)

            # Run all three backends in parallel via threads
            results: List[FusedItem] = []

            def run_all():
                threads = [
                    threading.Thread(
                        target=lambda: results.extend(self._call_hindsight(query, limit)),
                        name="fusion-hindsight",
                    ),
                    threading.Thread(
                        target=lambda: results.extend(self._call_qmd(query, limit)),
                        name="fusion-qmd",
                    ),
                    threading.Thread(
                        target=lambda: results.extend(self._call_sessiondb(query, limit)),
                        name="fusion-sessiondb",
                    ),
                ]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=60)
                return results

            try:
                all_items = run_all()
            except Exception as e:
                logger.error("Fusion parallel search failed: %s", e)
                return tool_error(f"Fusion search failed: {e}")

            if not all_items:
                return json.dumps({"result": "No results from any backend."})

            # Second-level RRF fusion
            fused = rrf_fuse(all_items, k=_RRF_K)
            top = fused[: limit * 2]  # return top results

            lines = []
            for item in top:
                rank = item.metadata.get("final_rank", "?")
                sources = item.metadata.get("fused_sources", [item.source])
                lines.append(
                    f"[{rank}] (sources: {', '.join(sources)}) {item.text[:300]}"
                )

            return json.dumps({
                "result": "\n".join(lines),
                "meta": {
                    "total_fused": len(fused),
                    "hindsight_count": sum(1 for i in all_items if i.source == "hindsight"),
                    "qmd_count": sum(1 for i in all_items if i.source == "qmd"),
                    "sessiondb_count": sum(1 for i in all_items if i.source == "sessiondb"),
                },
            })

        # ---- hindsight_retain ----
        elif tool_name == "hindsight_retain":
            content = args.get("content", "")
            if not content:
                return tool_error("Missing required parameter: content")
            context = args.get("context")
            tags = args.get("tags")
            try:
                result = _hindsight_retain(
                    content=content,
                    context=context,
                    tags=tags,
                    bank_id=self._hindsight_bank,
                )
                return json.dumps({"result": result})
            except Exception as e:
                logger.warning("hindsight_retain failed: %s", e)
                return tool_error(f"Failed to store memory: {e}")

        # ---- hindsight_recall ----
        elif tool_name == "hindsight_recall":
            query = args.get("query", "")
            if not query:
                return tool_error("Missing required parameter: query")
            limit = args.get("limit", 10)
            try:
                results = _hindsight_recall(
                    query=query,
                    bank_id=self._hindsight_bank,
                    budget=self._hindsight_budget,
                    limit=limit,
                )
                if not results:
                    return json.dumps({"result": "No relevant memories found."})
                lines = [f"{i+1}. {r['text']}" for i, r in enumerate(results)]
                return json.dumps({"result": "\n".join(lines)})
            except Exception as e:
                logger.warning("hindsight_recall failed: %s", e)
                return tool_error(f"Failed to search memory: {e}")

        # ---- hindsight_reflect ----
        elif tool_name == "hindsight_reflect":
            query = args.get("query", "")
            if not query:
                return tool_error("Missing required parameter: query")
            try:
                result = _hindsight_reflect(
                    query=query,
                    bank_id=self._hindsight_bank,
                    budget=self._hindsight_budget,
                )
                return json.dumps({"result": result})
            except Exception as e:
                logger.warning("hindsight_reflect failed: %s", e)
                return tool_error(f"Failed to reflect: {e}")

        # ---- sessiondb_search ----
        elif tool_name == "sessiondb_search":
            query = args.get("query", "")
            if not query:
                return tool_error("Missing required parameter: query")
            limit = args.get("limit", 10)
            items = self._call_sessiondb(query, limit)
            if not items:
                return json.dumps({"result": "No session results found."})
            lines = [f"{i+1}. {item.text[:200]}" for i, item in enumerate(items)]
            return json.dumps({"result": "\n".join(lines)})

        return tool_error(f"Unknown tool: {tool_name}")

    def _call_hindsight(self, query: str, limit: int) -> List[FusedItem]:
        results = _hindsight_recall(query, bank_id=self._hindsight_bank, budget=self._hindsight_budget)
        return [
            FusedItem(
                source="hindsight",
                text=r["text"],
                original_rank=i + 1,
                score=r.get("score", 0.0),
                metadata=r.get("metadata", {}),
            )
            for i, r in enumerate(results[:limit])
        ]

    def _call_qmd(self, query: str, limit: int) -> List[FusedItem]:
        results = _qmd_query(query, limit=limit)
        return [
            FusedItem(
                source="qmd",
                text=r["text"],
                original_rank=i + 1,
                score=r.get("score", 0.0),
                metadata=r.get("metadata", {}),
            )
            for i, r in enumerate(results[:limit])
        ]

    def _call_sessiondb(self, query: str, limit: int) -> List[FusedItem]:
        db = _get_session_db()
        if db is None:
            return []
        try:
            raw = db.search_messages(query, limit=limit)
            return [
                FusedItem(
                    source="sessiondb",
                    text=r.get("snippet", r.get("content", "")),
                    original_rank=i + 1,
                    score=1.0,  # BM25 rank-based, no separate score
                    metadata={
                        "source": "sessiondb",
                        "session_id": r.get("session_id", ""),
                        "role": r.get("role", ""),
                        "timestamp": r.get("timestamp", ""),
                    },
                )
                for i, r in enumerate(raw[:limit])
            ]
        except Exception as e:
            logger.warning("Fusion sessiondb search failed: %s", e)
            return []

    def shutdown(self) -> None:
        logger.info("FusionMemoryProvider shutdown")
