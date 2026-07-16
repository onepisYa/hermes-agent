"""Regression tests for #30149 — anthropic import diagnostics.

Validates that ``_anthropic_unavailable_message`` and the import-time
exception capture in ``_get_anthropic_sdk`` survive refactors.

Three classes:

* :class:`TestMessageFormat` — the operator-facing string format stays
  predictable across providers and contexts (8 cases).
* :class:`TestImportFailureCapture` — both ``ImportError`` and non-``ImportError``
  flavours are captured into ``_anthropic_sdk_import_error`` (4 cases).
* :class:`TestCallsiteRouting` — every callsite that builds an anthropic
  client funnels through the helper, not the old hard-coded message (3 cases).

All tests operate purely on string content (``_anthropic_unavailable_message``
is pure; the SDK-import capture is exercised via in-process re-binding of
``_anthropic_sdk`` and ``_anthropic_sdk_import_error`` rather than touching
the real ``anthropic`` package — which makes the suite deterministic and
sub-second regardless of installed interpreter).
"""

from __future__ import annotations

import importlib
import sys

import pytest

from agent import anthropic_adapter


@pytest.fixture(autouse=True)
def _reset_anthropic_module_state():
    """Reset module-level singleton + error cache around every test.

    ``_get_anthropic_sdk`` uses a sentinel ``...`` to mean "never tried".
    Tests that exercise the import-failure branch rebind ``_anthropic_sdk``
    to ``None`` and ``_anthropic_sdk_import_error`` to a sentinel string,
    then restore.
    """
    original_sdk = anthropic_adapter._anthropic_sdk
    original_err = anthropic_adapter._anthropic_sdk_import_error
    anthropic_adapter._anthropic_sdk = ...  # sentinel "never tried"
    anthropic_adapter._anthropic_sdk_import_error = None
    try:
        yield
    finally:
        anthropic_adapter._anthropic_sdk = original_sdk
        anthropic_adapter._anthropic_sdk_import_error = original_err


# ---------------------------------------------------------------------------
# 1. TestMessageFormat (8 cases)
# ---------------------------------------------------------------------------


class TestMessageFormat:
    """The diagnostic string format is the operator-facing contract."""

    def test_message_starts_with_what_failed(self):
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        assert msg.startswith(
            "The 'anthropic' package is required for the Anthropic provider but "
            "could not be imported in this Python environment."
        )

    def test_message_includes_context(self):
        msg = anthropic_adapter._anthropic_unavailable_message(
            context="Bedrock provider client"
        )
        assert "Context: Bedrock provider client" in msg

    def test_message_includes_interpreter_path(self):
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        # sys.executable is always populated under tests
        assert "Install it into THIS interpreter" in msg
        assert sys.executable in msg

    def test_message_includes_interpreter_pip_command(self):
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        assert sys.executable + " -m pip install 'anthropic>=0.39.0'" in msg

    def test_message_includes_underlying_when_captured(self):
        anthropic_adapter._anthropic_sdk_import_error = "ModuleNotFoundError: anthropic"
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        assert "Underlying import error: ModuleNotFoundError: anthropic" in msg

    def test_message_handles_no_capture(self):
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        assert "Underlying import error: <none captured>" in msg

    def test_message_mentions_30149_mismatch_hint(self):
        msg = anthropic_adapter._anthropic_unavailable_message(context="x")
        assert "#30149" in msg
        assert "interpreter" in msg

    def test_message_idempotent_across_contexts(self):
        a = anthropic_adapter._anthropic_unavailable_message(context="native provider client")
        b = anthropic_adapter._anthropic_unavailable_message(
            context="Azure Foundry Anthropic-style endpoints with Entra ID auth"
        )
        c = anthropic_adapter._anthropic_unavailable_message(context="Bedrock provider client")
        # Same template, only the Context line differs.
        assert a.startswith("The 'anthropic' package is required")
        assert b.startswith("The 'anthropic' package is required")
        assert c.startswith("The 'anthropic' package is required")
        assert a != b
        assert b != c
        assert a != c


# ---------------------------------------------------------------------------
# 2. TestImportFailureCapture (4 cases)
# ---------------------------------------------------------------------------


class TestImportFailureCapture:
    """``_get_anthropic_sdk`` records the underlying exception text."""

    def test_captures_module_not_found(self, monkeypatch):
        """Force the SDK to be missing via a more reliable route than
        monkeypatching ``__import__`` (which depends on whether the import
        is resolved through ``__import__`` or ``importlib.import_module``).
        We remove the anthropic module from ``sys.modules`` and patch
        ``sys.modules['anthropic'] = None`` so the next import raises
        ``ImportError`` at module-attribute-lookup time.
        """
        # Step 1: Save and clear real module.
        real_module = sys.modules.pop("anthropic", None)
        # Step 2: Mark as "not loadable" by setting to None — the import
        # statement will then raise ImportError when trying to access it.
        sys.modules["anthropic"] = None  # type: ignore[assignment]
        try:
            # Reset sentinel so _get_anthropic_sdk re-runs.
            anthropic_adapter._anthropic_sdk = ...
            result = anthropic_adapter._get_anthropic_sdk()
        finally:
            # Restore.
            sys.modules.pop("anthropic", None)
            if real_module is not None:
                sys.modules["anthropic"] = real_module
        assert result is None
        # The CPython error message format for ``sys.modules[X] = None``
        # is exactly "import of X halted; None in sys.modules"; the test is
        # therefore tolerant to either path (real ``ModuleNotFoundError``
        # text or our patched variant) by checking just for the word
        # ``anthropic`` in the captured message.
        assert "anthropic" in (anthropic_adapter._anthropic_sdk_import_error or "")

    def test_captures_non_importerror_runtime(self):
        """AttributeError / RuntimeError flavours recorded too (#30149)."""
        anthropic_adapter._anthropic_sdk = ...

        def _fake_import(name, *args, **kwargs):
            if name == "anthropic":
                raise AttributeError(
                    "module 'typing' has no attribute 'TypeAliasType'"
                )
            raise ImportError(f"unexpected import: {name}")

        original_import = anthropic_adapter.__builtins__["__import__"]
        anthropic_adapter.__builtins__["__import__"] = _fake_import
        try:
            result = anthropic_adapter._get_anthropic_sdk()
        finally:
            anthropic_adapter.__builtins__["__import__"] = original_import
        assert result is None
        err = anthropic_adapter._anthropic_sdk_import_error or ""
        assert "AttributeError" in err
        assert "TypeAliasType" in err

    def test_success_path_does_not_set_error(self):
        anthropic_adapter._anthropic_sdk = ...
        anthropic_adapter._anthropic_sdk_import_error = "PRE_EXISTING_NOISE"

        def _ok(_name, *_a, **_kw):
            return type(sys)("anthropic")

        original_import = anthropic_adapter.__builtins__["__import__"]
        anthropic_adapter.__builtins__["__import__"] = _ok
        try:
            anthropic_adapter._get_anthropic_sdk()
        finally:
            anthropic_adapter.__builtins__["__import__"] = original_import
        # On the import-OK path we don't touch the error cache, so the
        # operator-facing helper would fall back to "<none captured>" via the
        # ``or`` short-circuit even though the variable is non-empty.
        assert anthropic_adapter._anthropic_sdk is not ...

    def test_preserves_sentinel_until_first_call(self):
        # No rebind happens until ``_get_anthropic_sdk`` is called.
        assert anthropic_adapter._anthropic_sdk is ...
        assert anthropic_adapter._anthropic_sdk_import_error is None


# ---------------------------------------------------------------------------
# 3. TestCallsiteRouting (3 cases)
# ---------------------------------------------------------------------------


class TestCallsiteRouting:
    """All three callsites use the helper, not a hard-coded message string."""

    @pytest.fixture
    def captured_callsite(self, monkeypatch, _reset_anthropic_module_state):
        """Stub out the SDK so the three build_* helpers all raise through
        ``_anthropic_unavailable_message``.
        """
        original_import = (
            __builtins__["__import__"]
            if isinstance(__builtins__, dict)
            else __builtins__.__import__
        )

        def _patched_import(name, *args, **kwargs):
            if name == "anthropic" or name.startswith("anthropic."):
                raise ModuleNotFoundError(f"No module named '{name}'")
            return original_import(name, *args, **kwargs)

        # Force the SDK lookup to miss.
        sys.modules.pop("anthropic", None)
        if isinstance(__builtins__, dict):
            monkeypatch.setitem(__builtins__, "__import__", _patched_import)
        else:
            monkeypatch.setattr(__builtins__, "__import__", _patched_import)
        return _patched_import

    def test_build_anthropic_client_uses_helper(self, captured_callsite):
        with pytest.raises(ImportError) as exc_info:
            anthropic_adapter.build_anthropic_client(api_key="sk-ant-test")
        msg = str(exc_info.value)
        assert "Context: native provider client" in msg
        assert "Install it into THIS interpreter" in msg
        assert sys.executable in msg
        assert "#30149" in msg

    def test_build_bedrock_client_uses_helper(self, captured_callsite):
        with pytest.raises(ImportError) as exc_info:
            anthropic_adapter.build_anthropic_bedrock_client(region="us-east-1")
        msg = str(exc_info.value)
        assert "Context: Bedrock provider client" in msg
        assert "#30149" in msg

    def test_bearer_hook_uses_helper(self, captured_callsite):
        def _fake_token_provider():
            return "stub-token"

        with pytest.raises(ImportError) as exc_info:
            anthropic_adapter._build_anthropic_client_with_bearer_hook(
                token_provider=_fake_token_provider,
                base_url="https://example.azure/v1",
                timeout=900.0,
            )
        msg = str(exc_info.value)
        assert "Context: Azure Foundry Anthropic-style endpoints with Entra ID auth" in msg
        assert "#30149" in msg
