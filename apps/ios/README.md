# Hermes iOS ☤

The iOS shell for [Hermes Desktop](../desktop/README.md), built with
[Capacitor](https://capacitorjs.com). It wraps the same React renderer as the
desktop app in a WKWebView, in **remote-gateway-only mode**: there is no local
backend, no Hermes Cloud login window — the app connects to a Hermes gateway
you already run somewhere (`hermes dashboard` / `hermes serve` on a server)
over REST + the `/api/ws` JSON-RPC WebSocket.

## How it works

- The desktop renderer talks to its Electron main process through the
  `window.hermesDesktop` capability bridge. On iOS that bridge is implemented
  in the browser by
  [`apps/desktop/src/ios/bridge.ts`](../desktop/src/ios/bridge.ts): REST calls
  become in-page `fetch` against the gateway base URL (with the
  `X-Hermes-Session-Token` header, or the OAuth session cookie), and the
  WebSocket URL is minted in-page (`?token=` / single-use `?ticket=`).
- The bridge advertises `gatewayOnly: true`, which hides the Local and Cloud
  connection cards in Settings → Gateway and trims local-only recovery actions.
- Machine-local desktop features (local terminal, local git/fs, multi-window,
  updates, pet overlay, marketplace themes) are absent; files and git already
  route through the gateway's `/api/fs/*` and `/api/git/*` REST in remote mode.
- Capacitor's `CapacitorHttp` plugin is enabled so REST requests go through
  native URLSession — the gateway's localhost-only CORS policy does not apply
  to native requests. The `/api/ws` WebSocket upgrade explicitly tolerates
  non-web origins (same path packaged Electron uses).

## First run

On first launch the app has no gateway configured and lands on the recovery
card. Tap **Gateway settings**, enter your gateway URL
(`https://your-server.example.com` or `http://<lan-ip>:<port>`), paste the
session token (printed by the gateway on startup, or from
`HERMES_DASHBOARD_SESSION_TOKEN`), **Test connection**, then **Save &
reconnect**.

Static-token gateways are the primary supported path. OAuth-gated gateways are
best-effort: the login page opens externally and the app polls for the session
cookie, which requires the login flow to share cookies with the app's WebView.

## Building

The IPA is built by the [`iOS IPA` GitHub Actions workflow]
(../../.github/workflows/ios-ipa.yml) (manual `workflow_dispatch`, or on push
when iOS-relevant paths change). It produces an **unsigned** `.ipa` artifact
intended for sideloading — AltStore, Sideloadly, etc. re-sign it with your own
Apple ID at install time.

Locally (macOS with Xcode + CocoaPods):

```bash
npm install                              # repo root
npm run --prefix apps/desktop build:ios  # web bundle → apps/desktop/dist-ios
cd apps/ios
npx cap sync ios
npx cap open ios                         # build/run from Xcode
```

## Layout

- `capacitor.config.json` — app id, webDir (`../desktop/dist-ios`), CapacitorHttp.
- `ios/` — the generated Xcode project (committed; `pod install` runs on sync).
- Web-side iOS code lives in `apps/desktop/src/ios/` (bridge, entry, CSS) plus
  `apps/desktop/ios.html` and `apps/desktop/vite.ios.config.ts`.
