"""Tests for the native-app connect flow (mobile shells behind the gate).

Two seams under test:

  * ``GET /app-connect`` (dashboard_auth.routes) — gated route that hands the
    process-lifetime native-app token to an authenticated top-level visit,
    embedded in the URL fragment of an in-app return redirect.
  * ``middleware._native_token_session`` — the gate accepting that token back
    via ``X-Hermes-Session-Token`` on ``/api/*`` requests, as a full session
    equivalent (so ``/api/auth/ws-ticket`` and friends work unchanged).

Uses the same ``StubAuthProvider`` harness as the gate's E2E tests.
"""
from __future__ import annotations

import pytest

from fastapi.testclient import TestClient

from hermes_cli import web_server
from hermes_cli.dashboard_auth import clear_providers, register_provider
from tests.hermes_cli.conftest_dashboard_auth import StubAuthProvider

NATIVE_TOKEN = "native-app-token-for-tests"


@pytest.fixture
def gated_app():
    """Gated web_server.app + stub provider + native token enabled."""
    clear_providers()
    register_provider(StubAuthProvider())
    prev_host = getattr(web_server.app.state, "bound_host", None)
    prev_port = getattr(web_server.app.state, "bound_port", None)
    prev_required = getattr(web_server.app.state, "auth_required", None)
    prev_native = getattr(web_server.app.state, "native_client_token", None)
    web_server.app.state.bound_host = "fly-app.fly.dev"
    web_server.app.state.bound_port = 443
    web_server.app.state.auth_required = True
    web_server.app.state.native_client_token = NATIVE_TOKEN
    client = TestClient(web_server.app, base_url="https://fly-app.fly.dev")
    yield client
    clear_providers()
    web_server.app.state.bound_host = prev_host
    web_server.app.state.bound_port = prev_port
    web_server.app.state.auth_required = prev_required
    web_server.app.state.native_client_token = prev_native


def _complete_stub_login(client) -> None:
    """Walk the stub OAuth round trip so ``client`` carries a valid session."""
    r1 = client.get("/auth/login?provider=stub", follow_redirects=False)
    assert r1.status_code == 302
    state = r1.headers["location"].split("state=")[1]
    r2 = client.get(
        f"/auth/callback?code=stub_code&state={state}",
        follow_redirects=False,
    )
    assert r2.status_code == 302


# ---------------------------------------------------------------------------
# /app-connect
# ---------------------------------------------------------------------------


def test_app_connect_unauthenticated_redirects_to_login_with_next(gated_app):
    """No session → the gate bounces into the login flow carrying
    next=/app-connect (either the /login interstitial or the single-provider
    auto-SSO shortcut), so the round trip lands back on the handout page."""
    r = gated_app.get(
        "/app-connect?return=capacitor%3A%2F%2Flocalhost%2F",
        follow_redirects=False,
    )
    assert r.status_code == 302
    location = r.headers["location"]
    assert location.startswith(("/login", "/auth/login"))
    assert "next=" in location
    assert "app-connect" in location


def test_app_connect_authenticated_hands_out_token_in_fragment(gated_app):
    """A cookie-authenticated visit gets the native token in the URL FRAGMENT
    of an in-app return target (fragments never reach a server or its logs)."""
    _complete_stub_login(gated_app)
    r = gated_app.get(
        "/app-connect?return=capacitor%3A%2F%2Flocalhost%2F",
        follow_redirects=False,
    )
    assert r.status_code == 200
    assert f"capacitor://localhost/#hermes_app_token={NATIVE_TOKEN}" in r.text


def test_app_connect_rejects_foreign_return_target(gated_app):
    """An attacker-supplied return URL must fall back to the Capacitor
    default — the token never leaves the known in-app origins."""
    _complete_stub_login(gated_app)
    for evil in (
        "https://evil.example/",
        "capacitor://localhost@evil.example/",
        "javascript:alert(1)",
        "//evil.example",
    ):
        r = gated_app.get(
            f"/app-connect?return={evil}", follow_redirects=False,
        )
        assert r.status_code == 200
        assert "evil.example" not in r.text
        assert "javascript:" not in r.text
        assert "capacitor://localhost/#hermes_app_token=" in r.text


def test_app_connect_404_when_disabled(gated_app):
    """Empty native token (kill-switch) → the route is a 404, no handout."""
    web_server.app.state.native_client_token = ""
    _complete_stub_login(gated_app)
    r = gated_app.get("/app-connect", follow_redirects=False)
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Gate accepting the native token header
# ---------------------------------------------------------------------------


def test_gated_api_accepts_native_token_header(gated_app):
    """The handout token authenticates /api/* like a session cookie."""
    r = gated_app.get(
        "/api/sessions",
        headers={"X-Hermes-Session-Token": NATIVE_TOKEN},
    )
    assert r.status_code != 401, (
        f"native token should authenticate /api/sessions, got "
        f"{r.status_code}: {r.text}"
    )


def test_gated_api_rejects_wrong_native_token(gated_app):
    r = gated_app.get(
        "/api/sessions",
        headers={"X-Hermes-Session-Token": "wrong-token"},
    )
    assert r.status_code == 401


def test_gated_api_rejects_native_token_when_disabled(gated_app):
    web_server.app.state.native_client_token = ""
    r = gated_app.get(
        "/api/sessions",
        headers={"X-Hermes-Session-Token": NATIVE_TOKEN},
    )
    assert r.status_code == 401


def test_native_token_does_not_authenticate_html_routes(gated_app):
    """The header is an API credential only — document loads still gate."""
    r = gated_app.get(
        "/app-connect",
        headers={"X-Hermes-Session-Token": NATIVE_TOKEN},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"].startswith(("/login", "/auth/login"))
    assert "hermes_app_token" not in r.text


def test_native_token_can_mint_ws_ticket(gated_app):
    """The full mobile path: header-token REST minting a WS ?ticket=."""
    r = gated_app.post(
        "/api/auth/ws-ticket",
        headers={"X-Hermes-Session-Token": NATIVE_TOKEN},
    )
    assert r.status_code == 200, f"got {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("ticket")
