"""Tests for `GET /health`. No network, no binaries required."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from toolbox.app import PUBLIC_PATHS, app, require_token

TOOLS = ("yt-dlp", "ffmpeg", "fpcalc", "rsgain")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_health_is_ok(client: TestClient):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_health_reports_every_tool(client: TestClient):
    versions = client.get("/health").json()["versions"]
    assert set(versions) == set(TOOLS)
    for tool in TOOLS:
        assert versions[tool] is None or isinstance(versions[tool], str)


def test_health_reports_fixtures_mode(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    assert client.get("/health").json()["fixtures"] is False
    monkeypatch.setenv("MM_TOOLBOX_FIXTURES", "1")
    assert client.get("/health").json()["fixtures"] is True


def test_yt_dlp_version_is_present(client: TestClient):
    """yt-dlp is a runtime dependency, so it is importable even outside the image."""
    assert client.get("/health").json()["versions"]["yt-dlp"] is not None


def test_health_stays_public_when_a_token_is_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MM_TOOLBOX_TOKEN", "s3cret")
    assert "/health" in PUBLIC_PATHS
    assert client.get("/health").status_code == 200


def _request(path: str, authorization: str | None = None) -> Request:
    headers = [(b"authorization", authorization.encode())] if authorization else []
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": headers,
            "scheme": "http",
            "server": ("toolbox", 8100),
            "root_path": "",
        }
    )


def test_token_check_is_skipped_when_unset(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("MM_TOOLBOX_TOKEN", raising=False)
    require_token(_request("/tag"))  # does not raise


def test_protected_path_rejects_a_missing_or_wrong_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MM_TOOLBOX_TOKEN", "s3cret")
    for authorization in (None, "Bearer nope", "Basic s3cret", "s3cret"):
        with pytest.raises(HTTPException) as raised:
            require_token(_request("/tag", authorization))
        assert raised.value.status_code == 401


def test_protected_path_accepts_the_right_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MM_TOOLBOX_TOKEN", "s3cret")
    require_token(_request("/tag", "Bearer s3cret"))  # does not raise
