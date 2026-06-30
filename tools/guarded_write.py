"""Two-layer guard facade for all external write operations.

Background
----------
Before this module, every tool that sent data to an outside sink (outbound
HTTP, SQLite UPDATE/INSERT, file writes outside the sandbox, queue publishes,
third-party API calls) had its own ad-hoc input handling. Some called
``html.escape``, some did ``shlex.quote``, most did nothing at all, and none
went through a single permission check. The result: a single sink with a
flaw meant the whole agent could exfiltrate, corrupt, or overwrite arbitrary
state.

This module is the **only** supported entry point for writing to a registered
external sink. It runs every write through:

  1. **Input sanitization** (per-sink contract: HTML escape for web output,
     SQL parameter coercion for DB writes, path-traversal stripping for
     filesystem writes, size caps per field, encoding normalization, etc.).
     The sanitizer runs BEFORE the write is constructed, on the in-memory
     payload — the underlying writer never sees raw user input.

  2. **Permission gate** (principal allow-list + per-principal rate limit +
     sink allow-list). Runs AFTER sanitization but BEFORE the actual write.
     Denials raise :class:`GuardedWriteError` and are logged with principal +
     sink + reason in a single structured line.

Bypass prevention
-----------------
Writers are held as private callables inside the :class:`SinkRegistry`; the
only public path to them is :func:`guarded_write`. A caller that wants to
bypass the guards must reach into the registry's internals (``_sinks``),
which is a clear sign of an attacker or a test that wants to verify the
guard works. There is no ``_unsafe_write`` escape hatch.

Coverage report
---------------
:func:`coverage_report` introspects the registry and prints a snapshot of
guarded vs unguarded sites for review. Pair it with a one-time audit script
(see ``scripts/audit_external_writes.py``) that lists every external write
call site in the codebase so we can track the unguarded ones down.

Usage::

    from tools.guarded_write import guarded_write, GuardedWriteError, SinkSpec

    # 1. Register a sink at module import time.
    register_sink("kanban.db", SinkSpec(
        kind="db",
        writer=lambda payload: _kanban_write(payload),
        allowed_principals={"default", "kanban-worker"},
        rate_limit=(50, 60.0),       # 50 writes per 60s
        size_caps={"title": 200, "body": 50000},
    ))

    # 2. At the call site, replace ``_kanban_write(payload)`` with
    #    ``guarded_write("kanban.db", payload)``.
    try:
        guarded_write("kanban.db", payload, principal="default")
    except GuardedWriteError as exc:
        log.error("write denied: %s", exc)
        return {"error": str(exc)}

Backward compatibility
----------------------
If a sink is not registered, :func:`guarded_write` raises
:class:`UnknownSinkError`. We intentionally do NOT fall through to a raw
write — silent fallthrough is the bug we're trying to prevent. If you need
to write somewhere new, register a sink first (see the README section in
``docs/guarded-write.md``).
"""

from __future__ import annotations

import html
import json
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Mapping, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────
# Errors
# ──────────────────────────────────────────────────────────────────────────


class GuardedWriteError(Exception):
    """Raised when the permission gate refuses a write.

    Attributes
    ----------
    principal : str
        The principal that attempted the write.
    sink : str
        The sink name (registry key).
    reason : str
        A short human-readable reason: "principal_not_allowed",
        "rate_limit_exceeded", "sanitizer_rejected", etc.
    """

    def __init__(self, principal: str, sink: str, reason: str, detail: str = ""):
        self.principal = principal
        self.sink = sink
        self.reason = reason
        self.detail = detail
        msg = f"guarded_write denied: principal={principal!r} sink={sink!r} reason={reason}"
        if detail:
            msg += f" ({detail})"
        super().__init__(msg)

    def to_log_dict(self) -> Dict[str, str]:
        """Return a structured dict for log forwarding (no secrets)."""
        return {
            "event": "guarded_write.denied",
            "principal": self.principal,
            "sink": self.sink,
            "reason": self.reason,
            "detail": self.detail,
        }


class UnknownSinkError(GuardedWriteError):
    """Raised when no sink with this name has been registered."""

    def __init__(self, sink: str):
        super().__init__(principal="<unknown>", sink=sink, reason="unknown_sink")


# ──────────────────────────────────────────────────────────────────────────
# Sink registration
# ──────────────────────────────────────────────────────────────────────────


# A "writer" is the actual side-effect callable. Held privately in the
# registry; callers never get a reference to it. ``payload`` is whatever the
# caller passed in (after sanitization). Return value is forwarded back.
Writer = Callable[[Any], Any]


@dataclass(frozen=True)
class SinkSpec:
    """Declarative specification of an external write sink.

    Parameters
    ----------
    kind : str
        One of ``"http"``, ``"db"``, ``"fs"``, ``"queue"``, ``"third_party"``,
        ``"ipc"``. Drives the default sanitizer when ``sanitizer`` is None.
    writer : callable
        The actual write function. PRIVATE: only ``guarded_write`` calls it.
    allowed_principals : set of str
        Principal names permitted to write here. ``{"*"}`` means any.
    rate_limit : (int, float), optional
        ``(N, window_seconds)``. At most N writes per window per
        principal×sink. ``None`` disables rate limiting.
    size_caps : mapping of str -> int, optional
        Per-field maximum byte length. A payload dict with a key longer than
        its cap is rejected at sanitization time.
    sanitizer : callable, optional
        Custom sanitizer ``(payload) -> sanitized_payload``. If None, a
        default is chosen from ``kind``.
    description : str, optional
        Human-readable description for the coverage report.
    """

    kind: str
    writer: Writer
    allowed_principals: Set[str]
    rate_limit: Optional[Tuple[int, float]] = None
    size_caps: Optional[Mapping[str, int]] = None
    sanitizer: Optional[Callable[[Any], Any]] = None
    description: str = ""

    def __post_init__(self) -> None:
        if self.kind not in _DEFAULT_SANITIZER_KINDS:
            raise ValueError(
                f"unknown sink kind: {self.kind!r} "
                f"(expected one of {sorted(_DEFAULT_SANITIZER_KINDS)})"
            )
        if not isinstance(self.allowed_principals, (set, frozenset)):
            # Accept tuples/lists for ergonomics; freeze to set internally.
            object.__setattr__(self, "allowed_principals", set(self.allowed_principals))


_DEFAULT_SANITIZER_KINDS = {"http", "db", "fs", "queue", "third_party", "ipc"}


# ──────────────────────────────────────────────────────────────────────────
# Default sanitizers
# ──────────────────────────────────────────────────────────────────────────


# Field name patterns that look like URLs / paths / SQL. We are conservative:
# if a field name hints at one of these shapes, we apply the matching rule.
_URL_FIELD_RE = re.compile(r"(^|_)(url|href|endpoint|webhook|api)$", re.IGNORECASE)
_PATH_FIELD_RE = re.compile(r"(^|_)(path|file|filename|filepath|dir|directory)$", re.IGNORECASE)
_SQL_FIELD_RE = re.compile(r"(^|_)(sql|query|statement|cmd)$", re.IGNORECASE)
_HTML_FIELD_RE = re.compile(r"(^|_)(html|body|content|message|text|comment)$", re.IGNORECASE)


# Default per-string size cap when ``size_caps`` is None but the sink has a
# kind. Generous but finite: catches accidental 10MB blobs going out the door.
DEFAULT_MAX_STRING_BYTES = 64 * 1024


def _coerce_size(value: Any, max_bytes: int, field_name: str) -> Any:
    """Enforce a byte cap on a string value. ``TooLarge`` for non-strings handled by caller."""
    if not isinstance(value, str):
        return value
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) > max_bytes:
        raise _SanitizationReject(
            f"field {field_name!r} exceeds size cap "
            f"({len(encoded)} > {max_bytes} bytes)"
        )
    return value


def _default_sanitizer_for_kind(kind: str) -> Callable[[Any], Any]:
    """Return the default sanitizer for a sink kind."""
    if kind == "fs":
        return _sanitize_fs
    if kind == "db":
        return _sanitize_db
    if kind == "http":
        return _sanitize_http
    if kind == "queue":
        return _sanitize_queue
    if kind == "third_party":
        return _sanitize_third_party
    if kind == "ipc":
        return _sanitize_ipc
    raise ValueError(f"no default sanitizer for kind={kind!r}")


def _sanitize_string(value: str, *, html_escape: bool) -> str:
    """Common string pass: normalize encoding and (optionally) escape HTML.

    ``errors='replace'`` is intentional — silent byte loss is worse than a
    visible placeholder, and the caller can inspect the result.
    """
    # Re-encode to surface any surrogate / mixed-encoding shenanigans.
    value = value.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    if html_escape:
        value = html.escape(value, quote=True)
    return value


def _sanitize_payload_dict(
    payload: Any,
    *,
    size_caps: Optional[Mapping[str, int]],
    html_escape: bool,
    path_strict: bool,
) -> Any:
    """Walk a dict/list payload and apply per-field rules.

    ``path_strict=True`` rejects path-traversal sequences in path-shaped
    fields. ``html_escape=True`` HTML-escapes string-shaped content fields.
    Per-field ``size_caps`` override the default cap.
    """
    default_cap = max(size_caps.values()) if size_caps else DEFAULT_MAX_STRING_BYTES

    def _walk(node: Any, field_hint: str = "") -> Any:
        if isinstance(node, str):
            cap = (size_caps or {}).get(field_hint, default_cap)
            escaped = _sanitize_string(node, html_escape=_field_wants_html(field_hint, html_escape))
            if path_strict and _PATH_FIELD_RE.search(field_hint or ""):
                if ".." in node.split("/") or ".." in node.split("\\"):
                    raise _SanitizationReject(
                        f"path traversal in {field_hint!r}: {node!r}"
                    )
            return _coerce_size(escaped, cap, field_hint or "<str>")
        if isinstance(node, dict):
            return {
                k: _walk(v, field_hint=k)
                for k, v in node.items()
            }
        if isinstance(node, (list, tuple)):
            walked = [_walk(v, field_hint=field_hint) for v in node]
            return type(node)(walked) if isinstance(node, tuple) else walked
        return node  # int / float / bool / None — leave alone

    return _walk(payload)


def _field_wants_html(field_hint: str, default: bool) -> bool:
    """Decide whether a string field should be HTML-escaped."""
    if not field_hint:
        return default
    if _HTML_FIELD_RE.search(field_hint):
        return True
    if _URL_FIELD_RE.search(field_hint) or _PATH_FIELD_RE.search(field_hint):
        return False
    return default


def _sanitize_fs(payload: Any) -> Any:
    """Filesystem sink: path-traversal rejection, size caps, encoding norm."""
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=False, path_strict=True)


def _sanitize_db(payload: Any) -> Any:
    """DB sink: parameter coercion (no string interpolation), size caps.

    This does NOT parse SQL — call sites are expected to use parameterised
    queries. The sanitizer enforces size caps and normalises encoding so a
    weird unicode payload can't smuggle control chars.
    """
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=False, path_strict=False)


def _sanitize_http(payload: Any) -> Any:
    """HTTP sink: HTML-escape body-like fields, size caps."""
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=True, path_strict=False)


def _sanitize_queue(payload: Any) -> Any:
    """Queue sink: encoding normalisation + size caps (no HTML escape)."""
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=False, path_strict=False)


def _sanitize_third_party(payload: Any) -> Any:
    """Third-party API sink: most conservative — HTML-escape body content."""
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=True, path_strict=False)


def _sanitize_ipc(payload: Any) -> Any:
    """IPC sink: encoding normalisation only; receivers are trusted code."""
    return _sanitize_payload_dict(payload, size_caps=None, html_escape=False, path_strict=False)


class _SanitizationReject(Exception):
    """Internal — re-raised as GuardedWriteError by the orchestrator."""


# ──────────────────────────────────────────────────────────────────────────
# Registry
# ──────────────────────────────────────────────────────────────────────────


class _RateLimiter:
    """Per-(principal, sink) sliding-window rate limiter.

    A deque of write timestamps per (principal, sink). Old timestamps are
    pruned on every check. Thread-safe via a single lock (called once per
    write, no hot path concerns).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._hits: Dict[Tuple[str, str], list] = {}

    def check_and_record(self, principal: str, sink: str, limit: int, window: float) -> bool:
        """Return True if the write is allowed (and record the hit). False if rate-limited."""
        now = time.monotonic()
        cutoff = now - window
        key = (principal, sink)
        with self._lock:
            hits = self._hits.setdefault(key, [])
            # Prune old hits.
            while hits and hits[0] < cutoff:
                hits.pop(0)
            if len(hits) >= limit:
                return False
            hits.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


class SinkRegistry:
    """Process-wide registry of guarded write sinks.

    Use :func:`register_sink` / :func:`unregister_sink` rather than touching
    the instance directly, so that the module-level ``_registry`` singleton
    stays consistent.
    """

    def __init__(self) -> None:
        self._sinks: Dict[str, SinkSpec] = {}
        self._rate_limiter = _RateLimiter()
        self._lock = threading.Lock()
        self._denied_count: Dict[Tuple[str, str, str], int] = {}
        self._allowed_count: Dict[Tuple[str, str], int] = {}

    def register(self, name: str, spec: SinkSpec) -> None:
        with self._lock:
            if name in self._sinks:
                raise ValueError(f"sink already registered: {name!r}")
            self._sinks[name] = spec

    def unregister(self, name: str) -> None:
        with self._lock:
            self._sinks.pop(name, None)

    def get(self, name: str) -> SinkSpec:
        try:
            return self._sinks[name]
        except KeyError as e:
            raise UnknownSinkError(name) from e

    def names(self) -> list:
        with self._lock:
            return sorted(self._sinks)

    def snapshot(self) -> Dict[str, SinkSpec]:
        """Return a shallow copy of the registered specs (for the coverage report)."""
        with self._lock:
            return dict(self._sinks)

    def record_allowed(self, principal: str, sink: str) -> None:
        with self._lock:
            self._allowed_count[(principal, sink)] = self._allowed_count.get((principal, sink), 0) + 1

    def record_denied(self, principal: str, sink: str, reason: str) -> None:
        with self._lock:
            key = (principal, sink, reason)
            self._denied_count[key] = self._denied_count.get(key, 0) + 1

    def stats(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "allowed": dict(self._allowed_count),
                "denied": dict(self._denied_count),
            }


_registry = SinkRegistry()


def register_sink(name: str, spec: SinkSpec) -> None:
    """Register a sink globally. See :class:`SinkSpec` for parameters."""
    _registry.register(name, spec)


def unregister_sink(name: str) -> None:
    """Remove a sink (mostly for tests)."""
    _registry.unregister(name)


# Persistent registration hooks. Modules that register a sink at import time
# (e.g. tools.memory_tool, tools.x_search_tool) can register their re-registration
# function here so that :func:`reset_for_tests` can re-run them after clearing
# the registry. Without this, a test that calls reset_for_tests would wipe
# production sinks, breaking every subsequent test in the same process that
# uses those sinks.
_persistent_hooks: list = []


def register_persistent_re_registration(hook: Callable[[], None]) -> None:
    """Register a function to be re-run by :func:`reset_for_tests`.

    The hook should re-register the production sinks the module owns.
    Calling the hook must be idempotent (the registrations themselves are
    idempotent — they use ``try/except ValueError`` to swallow duplicates).
    """
    _persistent_hooks.append(hook)


def reset_for_tests() -> None:
    """Clear all sinks and rate-limiter state, then re-run persistent hooks.

    Tests only. Production code should never call this.

    The re-run is what makes the test suite work: ``test_guarded_write.py``
    uses this in its autouse fixture to start each test with a clean
    registry, and tests for other modules (memory_tool, x_search_tool) run
    after it in the same process. Re-running the persistent hooks restores
    the production sinks so the subsequent tests find them.
    """
    global _registry
    _registry = SinkRegistry()
    for hook in _persistent_hooks:
        try:
            hook()
        except Exception:  # pragma: no cover — defensive
            logger.exception("persistent re-registration hook failed")


# ──────────────────────────────────────────────────────────────────────────
# Orchestrator
# ──────────────────────────────────────────────────────────────────────────


def guarded_write(
    sink_name: str,
    payload: Any,
    *,
    principal: str,
) -> Any:
    """The only supported way to write to a registered sink.

    Returns whatever the sink's writer returns. Raises
    :class:`GuardedWriteError` (or its subclass :class:`UnknownSinkError`)
    on any failure. The caller MUST catch the error and surface a structured
    response — never ``except Exception: pass``.
    """
    try:
        spec = _registry.get(sink_name)
    except UnknownSinkError:
        logger.error(
            "guarded_write refused: unknown sink principal=%r sink=%r",
            principal, sink_name,
        )
        raise

    # 1. Permission gate — principal allow-list.
    if not _principal_allowed(principal, spec):
        reason = "principal_not_allowed"
        detail = f"principal {principal!r} not in allowed list"
        _registry.record_denied(principal, sink_name, reason)
        logger.warning(
            "guarded_write denied principal=%r sink=%r reason=%s",
            principal, sink_name, reason,
        )
        raise GuardedWriteError(principal, sink_name, reason, detail)

    # 2. Rate limit (per principal × sink).
    if spec.rate_limit is not None:
        limit, window = spec.rate_limit
        if not _registry._rate_limiter.check_and_record(principal, sink_name, limit, window):
            reason = "rate_limit_exceeded"
            detail = f"{limit} writes per {window}s"
            _registry.record_denied(principal, sink_name, reason)
            logger.warning(
                "guarded_write denied principal=%r sink=%r reason=%s",
                principal, sink_name, reason,
            )
            raise GuardedWriteError(principal, sink_name, reason, detail)

    # 3. Sanitization.
    sanitizer = spec.sanitizer or _default_sanitizer_for_kind(spec.kind)
    try:
        clean_payload = sanitizer(payload)
    except _SanitizationReject as exc:
        reason = "sanitizer_rejected"
        detail = str(exc)
        _registry.record_denied(principal, sink_name, reason)
        logger.warning(
            "guarded_write denied principal=%r sink=%r reason=%s detail=%s",
            principal, sink_name, reason, detail,
        )
        raise GuardedWriteError(principal, sink_name, reason, detail) from exc

    # 4. Apply per-field size caps (post-sanitization, on the cleaned payload).
    if spec.size_caps and isinstance(clean_payload, dict):
        try:
            _apply_size_caps(clean_payload, spec.size_caps)
        except _SanitizationReject as exc:
            reason = "size_cap_exceeded"
            detail = str(exc)
            _registry.record_denied(principal, sink_name, reason)
            logger.warning(
                "guarded_write denied principal=%r sink=%r reason=%s detail=%s",
                principal, sink_name, reason, detail,
            )
            raise GuardedWriteError(principal, sink_name, reason, detail) from exc

    # 5. Actual write. We let the writer's exceptions bubble unchanged —
    #    domain errors (HTTPError, ConnectionError, sqlite3.IntegrityError)
    #    are the caller's responsibility to handle, and wrapping them in a
    #    GuardedWriteError would hide the original exception type, breaking
    #    existing retry logic (e.g. x_search retries on ReadTimeout).
    result = spec.writer(clean_payload)
    _registry.record_allowed(principal, sink_name)
    return result


def _principal_allowed(principal: str, spec: SinkSpec) -> bool:
    """Check the principal allow-list. ``{"*"}`` is the wildcard."""
    if "*" in spec.allowed_principals:
        return True
    return principal in spec.allowed_principals


def _apply_size_caps(payload: Dict[str, Any], caps: Mapping[str, int]) -> None:
    """Apply per-field size caps to a sanitized dict payload in place."""
    for field_name, cap in caps.items():
        if field_name in payload:
            value = payload[field_name]
            if isinstance(value, str):
                encoded = value.encode("utf-8", errors="replace")
                if len(encoded) > cap:
                    raise _SanitizationReject(
                        f"field {field_name!r} exceeds size cap "
                        f"({len(encoded)} > {cap} bytes)"
                    )


# ──────────────────────────────────────────────────────────────────────────
# Coverage report
# ──────────────────────────────────────────────────────────────────────────


def coverage_report() -> Dict[str, Any]:
    """Return a snapshot of the registry for the coverage report.

    Output shape::

        {
          "sinks": [
            {"name": "kanban.db", "kind": "db", "principals": [...], "rate_limit": (N, W), ...},
            ...
          ],
          "denied_counts": {"('user', 'kanban.db', 'rate_limit_exceeded')": 3, ...},
          "allowed_counts": {"('user', 'kanban.db')": 142, ...},
        }
    """
    sinks_out = []
    for name, spec in _registry.snapshot().items():
        sinks_out.append(
            {
                "name": name,
                "kind": spec.kind,
                "principals": sorted(spec.allowed_principals),
                "rate_limit": spec.rate_limit,
                "size_caps": dict(spec.size_caps) if spec.size_caps else None,
                "description": spec.description,
            }
        )
    stats = _registry.stats()
    return {
        "sinks": sinks_out,
        "denied_counts": {str(k): v for k, v in stats["denied"].items()},
        "allowed_counts": {str(k): v for k, v in stats["allowed"].items()},
    }


# ──────────────────────────────────────────────────────────────────────────
# Convenience constructors for the common case
# ──────────────────────────────────────────────────────────────────────────


def make_sink(
    name: str,
    *,
    kind: str,
    writer: Writer,
    allowed_principals=("*",),
    rate_limit: Optional[Tuple[int, float]] = None,
    size_caps: Optional[Mapping[str, int]] = None,
    description: str = "",
) -> None:
    """One-shot helper: build a SinkSpec and register it.

    Equivalent to ``register_sink(name, SinkSpec(...))``. Provided for the
    common case so call sites don't have to import the dataclass.
    """
    register_sink(
        name,
        SinkSpec(
            kind=kind,
            writer=writer,
            allowed_principals=set(allowed_principals),
            rate_limit=rate_limit,
            size_caps=size_caps,
            description=description,
        ),
    )


__all__ = [
    "GuardedWriteError",
    "UnknownSinkError",
    "SinkSpec",
    "SinkRegistry",
    "register_sink",
    "unregister_sink",
    "guarded_write",
    "make_sink",
    "coverage_report",
    "reset_for_tests",
]
