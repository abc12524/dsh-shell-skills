"""Compatibility shim for shell-skills scripts (`from _envelope import ok, error`).

Shared shell-skills resolve their result envelope like this::

    try:                      # mobile runtimes ship _envelope.py next to the skill
        from _envelope import ok, error
    except ImportError:       # shell-tool: core.tools.envelope
        from core.tools.envelope import ok, error

The DSH runner ships no `core` package, so it puts this directory on sys.path
before loading a skill and the first import resolves here. The payload shape is
identical to `core/tools/envelope.py`.
"""
from __future__ import annotations

import json


def ok(result=None):
    """Build the success envelope; `result` should be a dict."""
    if result is None:
        result = {}
    return json.dumps({"status": "ok", "result": result}, ensure_ascii=False)


def error(message, code=None, **extra):
    """Build the failure envelope, optionally with a stable `code`."""
    payload = {"status": "error", "error": str(message)}
    if code is not None:
        payload["code"] = code
    for key, value in extra.items():
        if value is not None:
            payload[key] = value
    return json.dumps(payload, ensure_ascii=False)


def is_error(value):
    """Whether a parsed response is a failure envelope."""
    return isinstance(value, dict) and value.get("status") == "error"


def passthrough(result):
    """Pass a canonical envelope through; anything else becomes an error."""
    if isinstance(result, dict):
        return json.dumps(result, ensure_ascii=False)
    return error("unexpected payload", code="bad_response")