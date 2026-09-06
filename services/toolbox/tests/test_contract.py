"""The HTTP contract itself: every route, the bearer token, and the OpenAPI document."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from toolbox.app import PUBLIC_PATHS, app
from toolbox.contract import SCHEMA_VERSION, contract_hash

#: Every route the phase promises, with the operation id the generated client exposes.
EXPECTED_OPERATIONS: dict[tuple[str, str], str] = {
    ("get", "/health"): "health",
    #: P07: the Console's error decoder reads the taxonomy from here rather than
    #: keeping a second copy of `errors.py` in TypeScript.
    ("get", "/errors"): "errorCatalog",
    ("post", "/extract"): "extract",
    ("post", "/download"): "download",
    ("post", "/probe"): "probe",
    ("post", "/fingerprint"): "fingerprint",
    ("post", "/tag"): "tag",
    ("post", "/replaygain"): "replaygain",
    ("post", "/place"): "place",
    ("post", "/artwork/prepare"): "prepareArtwork",
    ("post", "/ytmusic/search"): "searchYtMusic",
    ("post", "/ytdlp/update"): "updateYtDlp",
    ("post", "/ytdlp/selftest"): "selftestYtDlp",
    ("post", "/cookies/test"): "testCookies",
}


def test_every_promised_route_exists():
    document = app.openapi()
    actual = {
        (method, path): operation["operationId"]
        for path, methods in document["paths"].items()
        for method, operation in methods.items()
    }
    assert actual == EXPECTED_OPERATIONS


def test_the_openapi_document_is_stable():
    """`bun run toolbox:openapi` must be able to run twice and change nothing."""
    assert app.openapi() == app.openapi()


def test_the_error_body_is_part_of_the_contract():
    schemas = app.openapi()["components"]["schemas"]
    assert set(schemas["ErrorBody"]["properties"]) >= {"code", "message", "hint", "action"}
    assert "LOCKED" in schemas["ErrorCode"]["enum"]


def test_the_download_route_documents_ndjson():
    responses = app.openapi()["paths"]["/download"]["post"]["responses"]
    assert "application/x-ndjson" in responses["200"]["content"]


def test_health_reports_the_tools_and_the_slot(client: TestClient):
    payload = client.get("/health").json()
    assert payload["ok"] is True
    assert payload["downloading"] is False
    assert set(payload["versions"]) == {"yt-dlp", "ffmpeg", "fpcalc", "rsgain"}
    assert payload["versions"]["yt-dlp"] is not None


def test_health_stays_public_when_a_token_is_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MM_TOOLBOX_TOKEN", "s3cret")
    assert "/health" in PUBLIC_PATHS
    assert client.get("/health").status_code == 200


def test_a_protected_route_needs_the_bearer_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("MM_TOOLBOX_TOKEN", "s3cret")
    body = {"url": "fixture://discovery"}
    assert client.post("/extract", json=body).status_code == 401
    assert (
        client.post("/extract", json=body, headers={"authorization": "Basic s3cret"}).status_code
        == 401
    )
    assert (
        client.post("/extract", json=body, headers={"authorization": "Bearer nope"}).status_code
        == 401
    )
    ok = client.post("/extract", json=body, headers={"authorization": "Bearer s3cret"})
    assert ok.status_code == 200


def test_requests_reject_unknown_fields(client: TestClient):
    """Parse, do not cast: a typo in a field name is an error, not a silent no-op."""
    response = client.post("/extract", json={"url": "fixture://discovery", "cookiez": "x"})
    assert response.status_code == 422


# --------------------------------------------------------------------------------------
# The contract statement: what stops a stale image looking healthy
# --------------------------------------------------------------------------------------


def test_health_states_the_contract_this_image_implements():
    """`GET /health` carries the hash the app compares against its generated client.

    Without it, a container one commit behind the app answers `ok: true` with four healthy
    binary versions while every call fails `422 extra_forbidden` — the failure that opened
    both MCP test reports and that nothing on this side could name.
    """
    body = TestClient(app).get("/health").json()
    assert body["schema_version"] == SCHEMA_VERSION
    assert body["contract_hash"] == contract_hash(app.openapi())
    assert len(body["contract_hash"]) == 16


def test_the_hash_is_stable_across_calls():
    assert contract_hash(app.openapi()) == contract_hash(app.openapi())


def test_prose_does_not_change_the_hash():
    """A reworded docstring must not read as a stale image, or the warning stops being read."""
    document = json.loads(json.dumps(app.openapi()))
    before = contract_hash(document)
    document["info"]["description"] = "rewritten"
    for path in document["paths"].values():
        for operation in path.values():
            operation["summary"] = "rewritten"
            operation["description"] = "rewritten"
    assert contract_hash(document) == before


def test_a_new_model_field_changes_the_hash():
    """The one thing that must be caught: a field the old image's models would refuse."""
    document = json.loads(json.dumps(app.openapi()))
    before = contract_hash(document)
    document["components"]["schemas"]["TagRequest"]["properties"]["brand_new"] = {"type": "string"}
    assert contract_hash(document) != before


def test_a_removed_route_changes_the_hash():
    document = json.loads(json.dumps(app.openapi()))
    before = contract_hash(document)
    del document["paths"]["/probe"]
    assert contract_hash(document) != before
