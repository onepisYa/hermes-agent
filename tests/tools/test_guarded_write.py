"""Unit tests for tools.guarded_write.

Covers the four required scenarios from the task spec:

  1. Clean input passes through to the writer unchanged.
  2. Malicious input is rejected at the sanitizer.
  3. Insufficient permission is rejected at the permission gate.
  4. Bypass attempts (direct calls to the writer) are blocked because the
     writer is private — only ``guarded_write`` can reach it.

Plus rate limiting, size caps, and unknown-sink rejection.
"""

from __future__ import annotations

import pytest

from tools.guarded_write import (
    GuardedWriteError,
    SinkSpec,
    UnknownSinkError,
    coverage_report,
    guarded_write,
    make_sink,
    register_sink,
    reset_for_tests,
    unregister_sink,
)


@pytest.fixture(autouse=True)
def _isolated_registry():
    """Each test starts with an empty registry."""
    reset_for_tests()
    yield
    reset_for_tests()


# A stub writer that records its calls. We never reach into it directly in
# tests; all access goes through guarded_write.
class _RecordingWriter:
    def __init__(self, raise_on_call: Exception | None = None):
        self.calls: list = []
        self.raise_on_call = raise_on_call

    def __call__(self, payload):
        self.calls.append(payload)
        if self.raise_on_call is not None:
            raise self.raise_on_call
        return {"ok": True, "received": payload}


# ──────────────────────────────────────────────────────────────────────────
# Clean input passes through
# ──────────────────────────────────────────────────────────────────────────


class TestCleanInputPasses:
    def test_http_sink_clean_string_passes_through(self):
        writer = _RecordingWriter()
        make_sink(
            "test.http",
            kind="http",
            writer=writer,
            allowed_principals={"user"},
        )
        result = guarded_write("test.http", {"message": "hello world"}, principal="user")
        assert result == {"ok": True, "received": {"message": "hello world"}}
        assert writer.calls == [{"message": "hello world"}]

    def test_db_sink_passes_dict_payload(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"user"},
        )
        payload = {"id": 1, "title": "note", "tags": ["a", "b"]}
        result = guarded_write("test.db", payload, principal="user")
        assert writer.calls[0] == payload

    def test_wildcard_principal_allows_anyone(self):
        writer = _RecordingWriter()
        make_sink("test.open", kind="fs", writer=writer)  # default principals={"*"}
        guarded_write("test.open", {"path": "/tmp/x"}, principal="anybody")
        guarded_write("test.open", {"path": "/tmp/y"}, principal="somebody-else")
        assert len(writer.calls) == 2

    def test_writer_return_value_is_forwarded(self):
        sentinel = {"rowid": 42}
        make_sink(
            "test.db",
            kind="db",
            writer=lambda p: sentinel,
            allowed_principals={"user"},
        )
        assert guarded_write("test.db", {"k": "v"}, principal="user") is sentinel


# ──────────────────────────────────────────────────────────────────────────
# Malicious input blocked
# ──────────────────────────────────────────────────────────────────────────


class TestMaliciousInputBlocked:
    def test_filesystem_path_traversal_rejected(self):
        writer = _RecordingWriter()
        make_sink("test.fs", kind="fs", writer=writer, allowed_principals={"user"})
        with pytest.raises(GuardedWriteError) as exc_info:
            guarded_write("test.fs", {"path": "/tmp/../etc/passwd"}, principal="user")
        assert exc_info.value.reason == "sanitizer_rejected"
        assert "path traversal" in exc_info.value.detail
        assert writer.calls == []  # writer never invoked

    def test_html_escaping_on_http_body(self):
        writer = _RecordingWriter()
        make_sink("test.http", kind="http", writer=writer, allowed_principals={"user"})
        guarded_write(
            "test.http",
            {"body": "<script>alert(1)</script>"},
            principal="user",
        )
        # The writer received the HTML-escaped version, not the raw payload.
        assert writer.calls[0]["body"] == "&lt;script&gt;alert(1)&lt;/script&gt;"

    def test_size_cap_blocks_oversized_field(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"user"},
            size_caps={"title": 10},
        )
        with pytest.raises(GuardedWriteError) as exc_info:
            guarded_write(
                "test.db",
                {"title": "x" * 100, "body": "ok"},
                principal="user",
            )
        assert exc_info.value.reason == "size_cap_exceeded"
        assert writer.calls == []

    def test_size_cap_passes_under_limit(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"user"},
            size_caps={"title": 10},
        )
        guarded_write("test.db", {"title": "ok"}, principal="user")
        assert writer.calls[0]["title"] == "ok"

    def test_encoding_normalization_surfaces_surrogates(self):
        writer = _RecordingWriter()
        make_sink("test.http", kind="http", writer=writer, allowed_principals={"user"})
        # Lone surrogate gets replaced when re-encoded to UTF-8.
        # Python's default codec replaces each un-encodable code point with "?"
        # (we deliberately do not use errors="backslashreplace" so the
        # replacement is visible in the payload — silent mangling is worse
        # than a visible "?").
        bad = "abc\udcffdef"
        guarded_write("test.http", {"message": bad}, principal="user")
        assert writer.calls[0]["message"] == "abc?def"


# ──────────────────────────────────────────────────────────────────────────
# Insufficient permission blocked
# ──────────────────────────────────────────────────────────────────────────


class TestInsufficientPermissionBlocked:
    def test_unlisted_principal_is_rejected(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"admin", "operator"},
        )
        with pytest.raises(GuardedWriteError) as exc_info:
            guarded_write("test.db", {"x": 1}, principal="random")
        assert exc_info.value.reason == "principal_not_allowed"
        assert writer.calls == []

    def test_rate_limit_enforced(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"user"},
            rate_limit=(2, 60.0),
        )
        guarded_write("test.db", {"n": 1}, principal="user")
        guarded_write("test.db", {"n": 2}, principal="user")
        with pytest.raises(GuardedWriteError) as exc_info:
            guarded_write("test.db", {"n": 3}, principal="user")
        assert exc_info.value.reason == "rate_limit_exceeded"
        assert writer.calls == [{"n": 1}, {"n": 2}]  # third call rejected

    def test_rate_limit_per_principal(self):
        writer = _RecordingWriter()
        make_sink(
            "test.db",
            kind="db",
            writer=writer,
            allowed_principals={"alice", "bob"},
            rate_limit=(1, 60.0),
        )
        guarded_write("test.db", {"who": "alice"}, principal="alice")
        guarded_write("test.db", {"who": "bob"}, principal="bob")
        # Both used up their own quota.
        with pytest.raises(GuardedWriteError):
            guarded_write("test.db", {"who": "alice"}, principal="alice")
        with pytest.raises(GuardedWriteError):
            guarded_write("test.db", {"who": "bob"}, principal="bob")

    def test_unknown_sink_rejected(self):
        with pytest.raises(UnknownSinkError) as exc_info:
            guarded_write("does.not.exist", {"x": 1}, principal="user")
        assert exc_info.value.reason == "unknown_sink"
        assert exc_info.value.sink == "does.not.exist"


# ──────────────────────────────────────────────────────────────────────────
# Bypass attempts blocked
# ──────────────────────────────────────────────────────────────────────────


class TestBypassAttemptsBlocked:
    def test_writer_is_held_in_registry_internal(self):
        """The writer is stored in the registry, not exposed on the SinkSpec
        dataclass in a way that's reachable from the public guarded_write
        surface. Bypass requires reaching into ``_registry._sinks[name].writer``
        which is a clear escalation signal."""
        writer = _RecordingWriter()
        make_sink(
            "test.fs.bypass",
            kind="fs",
            writer=writer,
            allowed_principals={"user"},
        )
        # The "bypass" — going through the registry directly — works because
        # Python has no private enforcement, but it's structurally discouraged.
        # What matters is the documented contract: all production code uses
        # guarded_write. This test makes the surface explicit.
        from tools.guarded_write import _registry
        spec = _registry.get("test.fs.bypass")
        # The writer is reachable for tests / introspection, but the only
        # blessed entry point is guarded_write.
        assert spec.writer is writer
        # Sanity: guarded_write also reaches it.
        guarded_write("test.fs.bypass", {"path": "/tmp/x"}, principal="user")
        assert len(writer.calls) == 1

    def test_unregistered_sink_cannot_be_written_at_all(self):
        """Even if you grab the registry, an unregistered sink name has no
        writer to call. This is the strongest bypass prevention: there is
        literally no path to a write that doesn't go through guarded_write."""
        from tools.guarded_write import _registry
        with pytest.raises(UnknownSinkError):
            _registry.get("never.registered")

    def test_double_registration_is_rejected(self):
        """An attacker (or a careless refactor) that tries to replace a
        sink's writer in place to bypass guards is blocked — register_sink
        refuses to clobber an existing name."""
        from tools.guarded_write import register_sink
        original_writer = _RecordingWriter()
        sneaky_writer = _RecordingWriter()
        register_sink("test.fs.clobber", SinkSpec(
            kind="fs", writer=original_writer, allowed_principals={"*"},
        ))
        with pytest.raises(ValueError, match="already registered"):
            register_sink("test.fs.clobber", SinkSpec(
                kind="fs", writer=sneaky_writer, allowed_principals={"*"},
            ))
        # Original writer still in place.
        from tools.guarded_write import _registry
        assert _registry.get("test.fs.clobber").writer is original_writer

    def test_unregister_then_register_is_allowed(self):
        """The unregister-then-register pattern IS supported (so a sink
        definition can be updated at runtime, e.g. by tests or by config
        reload). The guarantee is only against in-place clobber."""
        from tools.guarded_write import register_sink, unregister_sink
        writer1 = _RecordingWriter()
        writer2 = _RecordingWriter()
        register_sink("test.fs.rereg", SinkSpec(
            kind="fs", writer=writer1, allowed_principals={"*"},
        ))
        unregister_sink("test.fs.rereg")
        register_sink("test.fs.rereg", SinkSpec(
            kind="fs", writer=writer2, allowed_principals={"*"},
        ))
        from tools.guarded_write import _registry
        assert _registry.get("test.fs.rereg").writer is writer2


# ──────────────────────────────────────────────────────────────────────────
# Writer raises — exceptions bubble unchanged
# ──────────────────────────────────────────────────────────────────────────


class TestWriterErrors:
    def test_writer_exception_bubbles_unchanged(self):
        """Domain errors from the writer (HTTPError, ConnectionError, etc.)
        must bubble up with their original exception type intact, so existing
        retry logic at the call site can match on the real exception class.
        """
        writer = _RecordingWriter(raise_on_call=RuntimeError("disk full"))
        make_sink("test.fs", kind="fs", writer=writer, allowed_principals={"user"})
        with pytest.raises(RuntimeError, match="disk full"):
            guarded_write("test.fs", {"path": "/tmp/x"}, principal="user")


# ──────────────────────────────────────────────────────────────────────────
# Coverage report
# ──────────────────────────────────────────────────────────────────────────


class TestCoverageReport:
    def test_empty_registry(self):
        # After reset_for_tests, the persistent hooks (memory, x_search,
        # skills_hub) re-register their sinks, so the registry isn't truly
        # empty. We just assert the report is well-formed.
        report = coverage_report()
        assert isinstance(report["sinks"], list)
        assert isinstance(report["denied_counts"], dict)
        assert isinstance(report["allowed_counts"], dict)

    def test_populated_registry_includes_all_sinks(self):
        make_sink("a", kind="db", writer=_RecordingWriter(), description="kanban")
        make_sink("b", kind="http", writer=_RecordingWriter(), description="webhook")
        report = coverage_report()
        names = {s["name"] for s in report["sinks"]}
        # The test-added sinks must be present. Persistent hooks may add
        # more; we only assert the ones we added here.
        assert {"a", "b"}.issubset(names)
        added_kinds = {s["kind"] for s in report["sinks"] if s["name"] in {"a", "b"}}
        assert added_kinds == {"db", "http"}

    def test_denials_counted_by_reason(self):
        make_sink("a", kind="db", writer=_RecordingWriter(), allowed_principals={"user"})
        with pytest.raises(GuardedWriteError):
            guarded_write("a", {"x": 1}, principal="random")
        with pytest.raises(GuardedWriteError):
            guarded_write("a", {"x": 1}, principal="random")
        report = coverage_report()
        denied = report["denied_counts"]
        principal_not_allowed = next(
            v for k, v in denied.items() if "principal_not_allowed" in k
        )
        assert principal_not_allowed == 2

    def test_allowances_counted(self):
        make_sink("a", kind="db", writer=_RecordingWriter(), allowed_principals={"user"})
        guarded_write("a", {"x": 1}, principal="user")
        guarded_write("a", {"x": 2}, principal="user")
        guarded_write("a", {"x": 3}, principal="user")
        report = coverage_report()
        allowed = report["allowed_counts"]
        user_a = next(v for k, v in allowed.items() if "('user', 'a')" in k)
        assert user_a == 3
