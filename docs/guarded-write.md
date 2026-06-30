# Guarded writes

This document explains how to add new external write sinks to the guarded
pipeline. If you're adding a new outbound HTTP call, DB write, or
filesystem write that wasn't there before, you should register a sink
and route the call through `guarded_write`.

## Why

`tools/guarded_write.py` is the single chokepoint for all external writes.
Every call goes through two guards:

1. **Input sanitization** — escapes HTML, rejects path traversal, normalises
   encoding, enforces size caps. The sanitizer runs on the in-memory
   payload BEFORE the write is constructed, so the underlying writer
   never sees raw user input.

2. **Permission gate** — checks the principal against an allow-list, then
   checks a per-(principal × sink) rate limit, then runs the actual write.

The point is to make a sink-level vulnerability (a missing escape, a
permissive principal) the *only* place you have to fix, instead of
chasing every callsite that writes to that sink.

## When to register a sink

Register a sink when you're adding a call that:

- sends data to an external service (HTTP POST/PUT/PATCH/DELETE, a
  third-party API, a webhook, an IPC pipe)
- INSERTs or UPDATEs a row in a database the agent owns
- writes a file outside the agent's sandbox (e.g. memory, skills,
  scratch, anything in `~/.hermes/...` that other processes can see)
- publishes to a queue or message bus

You do NOT need to register a sink for:

- local computations (no external side effect)
- reads (GET, SELECT, file reads)
- writes to a subprocess's stdin (the subprocess is the boundary, not us)

## How to register

In the module that owns the write, add a registration function and call
it at module import time:

```python
from tools.guarded_write import (
    SinkSpec,
    guarded_write,
    register_persistent_re_registration,
    register_sink,
)


def _my_sink_writer(payload):
    """The actual side-effect. Holds the original write logic."""
    return requests.post(payload["url"], json=payload["body"], timeout=payload["timeout"])


def _register_my_sink():
    try:
        register_sink(
            "my.service.write",                # unique sink name
            SinkSpec(
                kind="http",                    # picks the default HTTP sanitizer
                writer=_my_sink_writer,         # the actual write
                allowed_principals={"my-tool", "default"},
                rate_limit=(60, 60.0),          # 60 calls per 60s
                size_caps={"body": 100_000},    # per-field byte cap
                description="My service write endpoint",
            ),
        )
    except ValueError:
        pass  # already registered (re-import)


_register_my_sink()
register_persistent_re_registration(_register_my_sink)
```

Then at the call site, replace the raw write with `guarded_write`:

```python
# Before
response = requests.post(url, json=body, timeout=10)

# After
try:
    response = guarded_write(
        "my.service.write",
        {
            "url": url,
            "body": body,
            "timeout": 10,
        },
        principal="my-tool",
    )
except GuardedWriteError as exc:
    return tool_error(f"write denied: {exc.reason}")
```

`GuardedWriteError` carries `principal`, `sink`, `reason`, and `detail`.
The `reason` is one of:

- `unknown_sink` — sink name not registered
- `principal_not_allowed` — caller not in allow-list
- `rate_limit_exceeded` — too many writes in the window
- `sanitizer_rejected` — input failed the per-kind sanitizer
- `size_cap_exceeded` — a field exceeded its declared cap

## Choosing the right kind

The `kind` field picks the default sanitizer. Pick the one that matches
the contract of the sink:

| `kind` | Sanitizer behaviour | Use for |
|--------|---------------------|---------|
| `fs` | rejects path traversal, normalises encoding | filesystem writes |
| `db` | normalises encoding, enforces size caps | SQL INSERT/UPDATE (use parameterised queries, the sanitizer does NOT parse SQL) |
| `http` | HTML-escapes body fields, normalises encoding | outbound HTTP |
| `queue` | normalises encoding | message-bus publishes |
| `third_party` | same as http but stricter on body HTML | third-party API calls where the receiver might echo the body |
| `ipc` | normalises encoding only | local IPC (the receiver is trusted code) |

For most outbound HTTP, `http` is the right choice. Use `third_party`
only when the body might be rendered back to a user (e.g. a Slack
message that's echoed in notifications).

## Choosing the principal

The principal is a string that identifies the calling code. The convention
is the tool name or module name:

- `"default"` — the main agent loop
- `"my-tool"` — a specific tool module
- `"cron"` — a cron job
- `"background-review"` — the self-improvement fork
- `"*"` — wildcard (anyone can write)

You should be specific. `"*"` is a smell — it means the sink has no real
permission model. If you find yourself reaching for `"*"`, the sink
probably shouldn't exist (a public write is just an unauthenticated
endpoint).

## Choosing the rate limit

The rate limit is `(N, window_seconds)`. Some good starting points:

- Interactive UI actions: `(30, 60.0)` — at most one per 2 seconds sustained
- Tool-triggered outbound HTTP: `(60, 60.0)` — one per second
- Background / cron: `(10, 60.0)` — generous
- Memory / state stores: `(10000, 60.0)` — effectively unlimited; the size cap is the real bound

If a sink is hitting its limit in practice, the right answer is usually
"this work shouldn't be in the agent loop" or "use a queue", not "raise
the rate limit".

## Migration checklist

When you migrate an existing call site to go through `guarded_write`:

- [ ] Pick a sink name (kebab-case, prefixed by the service: `myco.api.write`)
- [ ] Pick the `kind`
- [ ] Pick the principal(s) — be specific
- [ ] Pick a rate limit that matches the call frequency
- [ ] Pick a `description` for the coverage report
- [ ] Move the side-effect into a writer function (the closure pattern)
- [ ] Add `_register_xxx_sink()` and call it at import time
- [ ] Add `register_persistent_re_registration(_register_xxx_sink)` so test resets don't break the sink
- [ ] Replace the raw call with `guarded_write(sink_name, payload, principal=...)`
- [ ] Catch `GuardedWriteError` and surface it as a structured error to the caller
- [ ] Run the audit: `python3 scripts/audit_external_writes.py` — your new call site should show as `guarded: true`

## What NOT to do

- **Don't catch `GuardedWriteError` and silently swallow it.** That defeats the audit trail. Surface it.
- **Don't call `register_sink` with the same name twice.** It raises `ValueError`. Use the `try/except` pattern shown above, or call `unregister_sink` first.
- **Don't use `"*"` as the only principal.** That's not a guard.
- **Don't use `kind="http"` for a sink whose body the receiver renders as HTML without further escaping.** Use `third_party` instead, or write a custom sanitizer.
- **Don't rely on `writer_raised` reason.** Writer exceptions now bubble up unchanged (since v1.1.0). If your old code matched on `GuardedWriteError(reason="writer_raised")`, switch to matching the original exception class (`requests.ReadTimeout`, `sqlite3.IntegrityError`, etc.).
