"""JSON access logging (`docs/phases/P10-production.md` § Exploitation: "Logs JSON sur stdout
des trois services"). Regression test for the bug found in P10-verify-1: uvicorn's own access
log is plain text, not JSON, and `app.py` swallowed the requirement silently until now.
"""

from __future__ import annotations

import logging

import structlog
from fastapi.testclient import TestClient

from toolbox.app import app


def test_requests_are_logged_as_a_json_event() -> None:
    with structlog.testing.capture_logs() as captured, TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    events = [entry for entry in captured if entry.get("event") == "request"]
    assert events, f"no 'request' event was logged: {captured!r}"
    record = events[-1]
    assert record["method"] == "GET"
    assert record["path"] == "/health"
    assert record["status"] == 200
    assert isinstance(record["ms"], int | float)
    assert record["ms"] >= 0

    # The middleware re-silences `uvicorn.access` on every request — deliberately, since a real
    # `uvicorn.Server` elsewhere in this test process (`tests/conftest.py`'s `live_server`) can
    # re-enable it between tests via `configure_logging()`. Checking it right after a request,
    # in the same test as the one above, is what makes this assertion order-independent instead
    # of a race against whichever other test ran its own server last.
    assert logging.getLogger("uvicorn.access").disabled is True
