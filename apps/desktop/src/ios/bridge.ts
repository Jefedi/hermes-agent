/**
 * ios/bridge.ts — the gateway-only `window.hermesDesktop` implementation for
 * the iOS (Capacitor/WKWebView) shell.
 *
 * The desktop renderer talks to its Electron main process through the
 * `window.hermesDesktop` capability bridge (see src/global.d.ts). On iOS there
 * is no main process and no local backend: this module installs a browser-side
 * implementation of that bridge that supports EXACTLY ONE connection mode —
 * a remote Hermes gateway reached over REST (X-Hermes-Session-Token header or
 * OAuth session cookie) and the /api/ws JSON-RPC WebSocket. It mirrors the
 * behavior of the Electron handlers it replaces:
 *
 *   - api()                → electron/main.ts `hermes:api` + fetchJson()
 *   - getGatewayWsUrl()    → electron/main.ts freshGatewayWsUrl / ws-ticket mint
 *   - probeConnectionConfig() → electron/main.ts probeRemoteAuthMode()
 *   - testConnectionConfig()  → electron/main.ts testDesktopConnectionConfig()
 *   - connection-config CRUD  → electron/connection-config.ts coercion rules
 *
 * Everything machine-local (terminal, local git/fs, windows, updates, pet
 * overlay, marketplace themes, Hermes Cloud) is intentionally absent — the
 * renderer already guards every one of those surfaces with `?.`, and files/git
 * route through the gateway's /api/fs/* + /api/git/* REST in remote mode.
 *
 * Must be imported (for its side effect) BEFORE `src/main.tsx`.
 */
import { buildHermesWebSocketUrl } from '@hermes/shared'

import type {
  DesktopActiveProfile,
  DesktopAuthProvider,
  DesktopBootProgress,
  DesktopBootstrapState,
  DesktopConnectionConfig,
  DesktopConnectionConfigInput,
  DesktopConnectionProbeResult,
  DesktopConnectionTestResult,
  DesktopOauthLoginResult,
  DesktopOauthLogoutResult,
  HermesApiRequest,
  HermesConnection,
  HermesNotification,
  HermesPreviewTarget,
  HermesReadDirResult,
  HermesReadFileTextResult,
  HermesTerminalExit,
  HermesTerminalSession
} from '../global'

// ---------------------------------------------------------------------------
// Stored gateway config (localStorage). One global connection plus optional
// per-profile overrides, mirroring the desktop's connection-config scopes.
// ---------------------------------------------------------------------------

interface StoredGatewayScope {
  remoteUrl: string
  remoteAuthMode: 'oauth' | 'token'
  remoteToken: string
  remoteOauthConnected: boolean
}

interface StoredGatewayConfig {
  global: StoredGatewayScope | null
  profiles: Record<string, StoredGatewayScope>
}

const CONFIG_KEY = 'hermes-ios-gateway-config'
const PROFILE_KEY = 'hermes-ios-active-profile'
const PROJECT_DIR_KEY = 'hermes-ios-default-project-dir'
// Mirror of the native biometric-lock preference for the settings toggle's UI
// state (the native UserDefaults flag is the authority for the gate itself).
const BIOMETRIC_LOCK_KEY = 'hermes-ios-biometric-lock'
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Secure token storage (iOS Keychain via capacitor-secure-storage-plugin).
//
// The session token is the one secret in the config. When the native Keychain
// plugin is reachable the token lives THERE (accessible after-first-unlock,
// this device), and localStorage keeps only non-secret fields (URL, auth
// mode, flags). When the plugin is absent or unusable (browser/dev, older
// shell), everything degrades to the original localStorage behavior — the
// token is NEVER dropped. `secureTokens` is the in-memory source of truth for
// (synchronous) reads once hydrated at startup; writes fan out to the
// Keychain asynchronously.
// ---------------------------------------------------------------------------

const SECURE_TOKEN_KEY_PREFIX = 'hermes_gateway_token_'
const GLOBAL_TOKEN_CACHE_KEY = '__global__'
const secureTokens = new Map<string, string>()
let secureStoreActive = false

function tokenCacheKey(key: null | string): string {
  return key || GLOBAL_TOKEN_CACHE_KEY
}

function getNativePromise(): null | (<T>(plugin: string, method: string, options?: unknown) => Promise<T>) {
  const cap = (
    window as {
      Capacitor?: { nativePromise?: <T>(plugin: string, method: string, options?: unknown) => Promise<T> }
    }
  ).Capacitor

  return typeof cap?.nativePromise === 'function' ? cap.nativePromise : null
}

// Cap every native Keychain call: a plugin that never calls back must not
// leave a hung promise around (the hydrate runs in the background, but a
// stalled call could otherwise wedge the migration forever).
const SECURE_CALL_TIMEOUT_MS = 4_000

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false

    const done = (value: T) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }

    const timer = setTimeout(() => done(fallback), SECURE_CALL_TIMEOUT_MS)
    promise.then(
      value => {
        clearTimeout(timer)
        done(value)
      },
      () => {
        clearTimeout(timer)
        done(fallback)
      }
    )
  })
}

async function secureSet(cacheKey: string, value: string): Promise<boolean> {
  const np = getNativePromise()

  if (!np) {
    return false
  }

  return withTimeout(
    np('SecureStoragePlugin', 'set', { key: `${SECURE_TOKEN_KEY_PREFIX}${cacheKey}`, value }).then(() => true),
    false
  )
}

async function secureGet(cacheKey: string): Promise<null | string> {
  const np = getNativePromise()

  if (!np) {
    return null
  }

  return withTimeout(
    np<{ value?: string }>('SecureStoragePlugin', 'get', {
      key: `${SECURE_TOKEN_KEY_PREFIX}${cacheKey}`
    }).then(result => (typeof result?.value === 'string' ? result.value : null)),
    null
  )
}

async function secureRemove(cacheKey: string): Promise<void> {
  const np = getNativePromise()

  if (!np) {
    return
  }

  try {
    await np('SecureStoragePlugin', 'remove', { key: `${SECURE_TOKEN_KEY_PREFIX}${cacheKey}` })
  } catch {
    // Best-effort.
  }
}

// Overlay the Keychain-cached token onto a freshly-parsed config so every
// existing `.remoteToken` reader sees the real secret. No-op (cache empty)
// when the secure store is inactive.
function overlaySecureTokens(config: StoredGatewayConfig) {
  if (config.global) {
    const token = secureTokens.get(GLOBAL_TOKEN_CACHE_KEY)

    if (token !== undefined) {
      config.global.remoteToken = token
    }
  }

  for (const [name, scope] of Object.entries(config.profiles)) {
    const token = secureTokens.get(name)

    if (token !== undefined && scope) {
      scope.remoteToken = token
    }
  }
}

function readStoredConfig(): StoredGatewayConfig {
  let config: StoredGatewayConfig = { global: null, profiles: {} }

  try {
    const raw = localStorage.getItem(CONFIG_KEY)

    if (raw) {
      const parsed = JSON.parse(raw) as StoredGatewayConfig
      config = { global: parsed.global ?? null, profiles: parsed.profiles ?? {} }
    }
  } catch {
    // Corrupt/absent config falls through to empty.
  }

  overlaySecureTokens(config)

  return config
}

// Route a scope's token to the Keychain + in-memory cache; empty clears it.
function persistSecureToken(cacheKey: string, token: string) {
  if (token) {
    secureTokens.set(cacheKey, token)
    void secureSet(cacheKey, token)
  } else {
    secureTokens.delete(cacheKey)
    void secureRemove(cacheKey)
  }
}

function writeStoredConfig(config: StoredGatewayConfig) {
  if (!secureStoreActive) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config))

    return
  }

  // Secret goes to the Keychain; localStorage keeps a token-blanked copy.
  const stripped: StoredGatewayConfig = {
    global: config.global ? { ...config.global, remoteToken: '' } : null,
    profiles: {}
  }

  if (config.global) {
    persistSecureToken(GLOBAL_TOKEN_CACHE_KEY, config.global.remoteToken || '')
  }

  for (const [name, scope] of Object.entries(config.profiles)) {
    persistSecureToken(name, scope.remoteToken || '')
    stripped.profiles[name] = { ...scope, remoteToken: '' }
  }

  localStorage.setItem(CONFIG_KEY, JSON.stringify(stripped))
}

// Startup migration: probe the Keychain, then move any localStorage tokens
// into it (and load any tokens already stored there) before the app boots.
// Resolves — never rejects — so a Keychain hiccup can't block startup.
async function hydrateSecureTokens(): Promise<void> {
  if (!getNativePromise()) {
    // No native bridge (browser/dev): stay on localStorage tokens.
    return
  }

  const canaryWritten = await secureSet('__canary__', '1')
  const canaryRead = canaryWritten ? await secureGet('__canary__') : null
  await secureRemove('__canary__')

  if (canaryRead !== '1') {
    log('secure token store unavailable; keeping tokens in localStorage')

    return
  }

  secureStoreActive = true

  // Read the RAW config (overlay is a no-op here — cache is still empty).
  let raw: StoredGatewayConfig = { global: null, profiles: {} }

  try {
    const stored = localStorage.getItem(CONFIG_KEY)

    if (stored) {
      const parsed = JSON.parse(stored) as StoredGatewayConfig
      raw = { global: parsed.global ?? null, profiles: parsed.profiles ?? {} }
    }
  } catch {
    // fall through to empty
  }

  const loadScope = async (cacheKey: string, scope: null | StoredGatewayScope) => {
    if (scope?.remoteToken) {
      // Migrate an existing localStorage token into the Keychain.
      await secureSet(cacheKey, scope.remoteToken)
      secureTokens.set(cacheKey, scope.remoteToken)
    } else {
      const stored = await secureGet(cacheKey)

      if (stored) {
        secureTokens.set(cacheKey, stored)
      }
    }
  }

  await loadScope(GLOBAL_TOKEN_CACHE_KEY, raw.global)

  for (const [name, scope] of Object.entries(raw.profiles)) {
    await loadScope(name, scope)
  }

  // Rewrite localStorage without the secrets (secureStoreActive now strips).
  writeStoredConfig(raw)
  log('secure token store active (iOS Keychain)')
}

function scopeKey(profile?: null | string): null | string {
  const key = String(profile ?? '').trim()

  return key || null
}

function scopeFor(config: StoredGatewayConfig, profile?: null | string): StoredGatewayScope | null {
  const key = scopeKey(profile)

  if (key && config.profiles[key]?.remoteUrl) {
    return config.profiles[key]
  }

  return config.global
}

// Mirrors electron/connection-config.ts normalizeRemoteBaseUrl.
function normalizeRemoteBaseUrl(rawUrl: string): string {
  const value = String(rawUrl || '').trim()

  if (!value) {
    throw new Error('Remote gateway URL is required.')
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Remote gateway URL is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  return parsed.toString().replace(/\/+$/, '')
}

function tokenPreview(value: string): null | string {
  const raw = String(value || '')

  if (!raw) {
    return null
  }

  return raw.length <= 8 ? 'set' : `...${raw.slice(-6)}`
}

// ---------------------------------------------------------------------------
// Diagnostics ring buffer (surfaces in the boot-failure overlay's log view).
// ---------------------------------------------------------------------------

const recentLogs: string[] = []

function log(line: string) {
  recentLogs.push(`${new Date().toISOString()} ${line}\n`)

  if (recentLogs.length > 200) {
    recentLogs.splice(0, recentLogs.length - 200)
  }
}

// ---------------------------------------------------------------------------
// Tiny event registries for the bridge's subscription surfaces.
// ---------------------------------------------------------------------------

type Listener<T> = (payload: T) => void

function createEmitter<T>() {
  const listeners = new Set<Listener<T>>()

  return {
    emit(payload: T) {
      for (const listener of [...listeners]) {
        try {
          listener(payload)
        } catch {
          // A broken subscriber must not break the others.
        }
      }
    },
    on(listener: Listener<T>) {
      listeners.add(listener)

      return () => void listeners.delete(listener)
    }
  }
}

const connectionApplied = createEmitter<void>()

// ---------------------------------------------------------------------------
// Keep-awake (Screen Wake Lock) + wake/resume signal.
//
// iOS freezes a backgrounded WebView (timers stop, the WS drops). Two helpers
// smooth the return: a screen wake lock keeps the display on during a long
// turn (the renderer's Settings toggle drives setKeepAwake), and onPowerResume
// gives the gateway-boot reconnect an extra nudge on foreground. The lock is
// released by the OS whenever the page hides, so it's re-acquired on the next
// visible transition while keep-awake stays on.
// ---------------------------------------------------------------------------

interface WakeLockSentinelLike {
  addEventListener?: (type: 'release', listener: () => void) => void
  release: () => Promise<void>
}

let wakeLockSentinel: WakeLockSentinelLike | null = null
let keepAwakeWanted = false

function wakeLockApi(): { request: (type: 'screen') => Promise<WakeLockSentinelLike> } | null {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
  }

  return nav.wakeLock ?? null
}

async function acquireWakeLock(): Promise<void> {
  if (!keepAwakeWanted || wakeLockSentinel || document.visibilityState !== 'visible') {
    return
  }

  const api = wakeLockApi()

  if (!api) {
    return
  }

  try {
    wakeLockSentinel = await api.request('screen')
    wakeLockSentinel.addEventListener?.('release', () => {
      wakeLockSentinel = null
    })
  } catch {
    wakeLockSentinel = null
  }
}

async function releaseWakeLock(): Promise<void> {
  const sentinel = wakeLockSentinel
  wakeLockSentinel = null

  try {
    await sentinel?.release()
  } catch {
    // Already released (e.g. by the OS on hide).
  }
}

const powerResume = createEmitter<void>()

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Re-acquire the lock the OS dropped on hide, and nudge a reconnect.
      void acquireWakeLock()
      powerResume.emit()
    }
  })

  window.addEventListener('pageshow', () => powerResume.emit())
}

// Step-by-step record of the LAST notify() attempt, surfaced by the
// notifications settings' test button so a silent false has an on-screen
// explanation (permission state, plugin error, missing bridge) instead of
// the generic "not supported" copy.
let lastNotifyDiagnostic = 'No notification attempt has been made yet.'

// ---------------------------------------------------------------------------
// REST plumbing.
// ---------------------------------------------------------------------------

function requireScope(profile?: null | string): StoredGatewayScope {
  const scope = scopeFor(readStoredConfig(), profile)

  if (!scope?.remoteUrl) {
    throw new Error('No Hermes gateway is configured yet. Open Gateway settings and enter your gateway URL and token.')
  }

  return scope
}

// In global-remote mode one backend serves every profile, so profile-scoped
// REST calls carry the scope as a query parameter (mirrors
// electron/connection-config.ts pathWithGlobalRemoteProfile, with
// globalRemote always true on iOS unless the profile has its own override).
function pathWithProfile(path: string, profile?: null | string): string {
  const scoped = scopeKey(profile)

  if (!scoped || !path) {
    return path
  }

  const config = readStoredConfig()

  if (config.profiles[scoped]?.remoteUrl) {
    return path
  }

  let parsed: URL

  try {
    parsed = new URL(path, 'http://hermes.local')
  } catch {
    return path
  }

  if (parsed.searchParams.has('profile')) {
    return path
  }

  parsed.searchParams.set('profile', scoped)

  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

interface FetchJsonOptions {
  method?: string
  body?: unknown
  upload?: HermesApiRequest['upload']
  timeoutMs?: number
}

// Mirrors electron/main.ts fetchJson(): same error message shapes so renderer
// error handling (status parsing, HTML fallthrough diagnostics) matches.
async function fetchGatewayJson<T>(url: string, scope: StoredGatewayScope, options: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {}
  let body: BodyInit | undefined

  if (options.upload) {
    const form = new FormData()

    const bytes =
      options.upload.bytes instanceof ArrayBuffer ? new Uint8Array(options.upload.bytes) : options.upload.bytes

    form.append(
      'file',
      new Blob([bytes as BlobPart], { type: options.upload.contentType || 'application/octet-stream' }),
      options.upload.filename
    )
    body = form
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  // Both auth modes present the session token header when one is held. For
  // OAuth-gated gateways the token comes from the /app-connect handout (the
  // gateway's SameSite=Lax cookies can never ride a cross-site fetch from
  // this app origin); cookie credentials remain a fallback for the rare
  // same-site embedding.
  if (scope.remoteToken) {
    headers['X-Hermes-Session-Token'] = scope.remoteToken
  }

  let response: Response

  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
      credentials: scope.remoteAuthMode === 'oauth' && !scope.remoteToken ? 'include' : 'omit'
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out connecting to Hermes backend after ${timeoutMs}ms`)
    }

    throw error
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()

  if (response.status >= 400) {
    throw new Error(`${response.status}: ${text || response.statusText}`)
  }

  if (!text) {
    return null as T
  }

  const looksHtml = /^\s*<(?:!doctype|html)/i.test(text)
  const contentType = response.headers.get('content-type') || ''

  if (looksHtml || contentType.includes('text/html')) {
    throw new Error(
      `Expected JSON from ${url} but got HTML (status ${response.status}). ` +
        'The endpoint is likely missing on the Hermes backend.'
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON from ${url} (status ${response.status}): ${text.slice(0, 200)}`)
  }
}

async function fetchPublicJson<T>(url: string, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' })
    const text = await response.text()

    if (response.status >= 400) {
      throw new Error(`${response.status}: ${text || response.statusText}`)
    }

    return JSON.parse(text) as T
  } finally {
    clearTimeout(timer)
  }
}

// Async on purpose: several callers invoke api() during React render and only
// handle promise rejections — an unconfigured gateway must reject, never throw
// synchronously into the render (it would trip the root error boundary).
async function gatewayApi<T>(request: HermesApiRequest): Promise<T> {
  const scope = requireScope(request.profile)
  const path = pathWithProfile(request.path, request.profile)

  return fetchGatewayJson<T>(`${scope.remoteUrl}${path}`, scope, {
    method: request.method,
    body: request.body,
    upload: request.upload,
    timeoutMs: request.timeoutMs
  })
}

// ---------------------------------------------------------------------------
// WebSocket URL resolution (token ?token= / OAuth single-use ?ticket=).
// ---------------------------------------------------------------------------

function wsUrlFromBase(baseUrl: string, authParam: readonly [string, string], path = '/api/ws'): string {
  const parsed = new URL(baseUrl)

  return buildHermesWebSocketUrl({
    path,
    basePath: parsed.pathname.replace(/\/+$/, ''),
    authParam,
    protocol: parsed.protocol,
    host: parsed.host
  })
}

// Resolve an authed WS URL for any gateway endpoint (/api/ws, /api/pty, …).
// Token gateways bake ?token=; OAuth gateways mint a fresh single-use
// ?ticket= right before dialing. Returns null when token mode has no token.
async function authedWsUrl(scope: StoredGatewayScope, path: string): Promise<null | string> {
  if (scope.remoteAuthMode === 'oauth') {
    return wsUrlFromBase(scope.remoteUrl, ['ticket', await mintWsTicket(scope)], path)
  }

  if (!scope.remoteToken) {
    return null
  }

  return wsUrlFromBase(scope.remoteUrl, ['token', scope.remoteToken], path)
}

async function mintWsTicket(scope: StoredGatewayScope): Promise<string> {
  const result = await fetchGatewayJson<{ ticket?: string }>(`${scope.remoteUrl}/api/auth/ws-ticket`, scope, {
    method: 'POST',
    timeoutMs: 10_000
  })

  const ticket = result?.ticket

  if (!ticket) {
    throw new Error('The gateway did not return a WebSocket ticket.')
  }

  return ticket
}

function isAuthRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /^40[13]:/.test(message)
}

async function freshGatewayWsUrl(profile?: null | string) {
  try {
    const scope = requireScope(profile)

    if (scope.remoteAuthMode === 'oauth') {
      const ticket = await mintWsTicket(scope)

      return { ok: true as const, wsUrl: wsUrlFromBase(scope.remoteUrl, ['ticket', ticket]) }
    }

    if (!scope.remoteToken) {
      return { ok: false as const, error: 'No gateway session token is configured.' }
    }

    return { ok: true as const, wsUrl: wsUrlFromBase(scope.remoteUrl, ['token', scope.remoteToken]) }
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      ...(isAuthRejection(error) ? { needsOauthLogin: true as const } : {})
    }
  }
}

// Dial the /api/ws endpoint briefly so a connection test exercises the same
// transport the app actually uses (mirrors electron/gateway-ws-probe.ts).
function probeGatewayWebSocket(wsUrl: string, timeoutMs = 8_000): Promise<{ ok: boolean; reason?: string }> {
  return new Promise(resolve => {
    let settled = false

    const settle = (result: { ok: boolean; reason?: string }) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
    }

    let socket: WebSocket

    try {
      socket = new WebSocket(wsUrl)
    } catch (error) {
      settle({ ok: false, reason: error instanceof Error ? error.message : String(error) })

      return
    }

    const timer = setTimeout(() => {
      socket.close()
      settle({ ok: false, reason: `The WebSocket did not open within ${timeoutMs}ms.` })
    }, timeoutMs)

    socket.onopen = () => {
      socket.close()
      settle({ ok: true })
    }

    socket.onerror = () => {
      settle({ ok: false, reason: 'The WebSocket connection was rejected.' })
    }
  })
}

// ---------------------------------------------------------------------------
// Remote terminal (the shell/TERMINAL pane).
//
// The desktop terminal drives a LOCAL node-pty shell over the Electron
// `window.hermesDesktop.terminal` capability. iOS has no local shell, so this
// implements the SAME interface (start/write/resize/onData/onExit/dispose)
// against the gateway's PTY-over-WebSocket endpoint `/api/pty` — the same
// transport the browser dashboard's terminal uses. The pane therefore shows
// the REMOTE machine's Hermes TUI, driven from the phone.
//
// Wire protocol (mirrors hermes_cli/web_server.py::pty_ws):
//   * bytes both directions — keystrokes up, PTY output down;
//   * resize is an in-band escape `\x1b[RESIZE:<cols>;<rows>]` consumed by the
//     server, never written to the child;
//   * auth via the same ?token= / single-use ?ticket= query the main WS uses.
// ---------------------------------------------------------------------------

interface IosPtySession {
  buffer: string[]
  closed: boolean
  cwd: string
  dataListeners: Set<(payload: string) => void>
  exitListeners: Set<(payload: HermesTerminalExit) => void>
  flushed: boolean
  shell: string
  ws: WebSocket
}

const ptySessions = new Map<string, IosPtySession>()
const ptyTextDecoder = typeof TextDecoder === 'function' ? new TextDecoder() : null

function ptyResizeFrame(cols: number, rows: number): string {
  return `[RESIZE:${Math.max(1, Math.floor(cols))};${Math.max(1, Math.floor(rows))}]`
}

function emitPtyData(session: IosPtySession, text: string) {
  if (!text) {
    return
  }

  // Nothing listening yet (start() resolves before the renderer attaches
  // onData) — buffer so the TUI's first paint isn't lost.
  if (session.dataListeners.size === 0) {
    session.buffer.push(text)

    return
  }

  for (const listener of [...session.dataListeners]) {
    try {
      listener(text)
    } catch {
      // A broken listener must not stall the stream.
    }
  }
}

function decodePtyMessage(data: unknown): string | null {
  if (typeof data === 'string') {
    return data
  }

  if (data instanceof ArrayBuffer && ptyTextDecoder) {
    return ptyTextDecoder.decode(new Uint8Array(data))
  }

  return null
}

let ptySeq = 0

async function startPtySession(options?: { cols?: number; cwd?: string; rows?: number }): Promise<HermesTerminalSession> {
  const scope = requireScope()
  const wsUrl = await authedWsUrl(scope, '/api/pty')

  if (!wsUrl) {
    throw new Error('No gateway session token is configured for the terminal.')
  }

  const id = `ios-pty-${++ptySeq}-${Date.now() % 100000}`

  return new Promise<HermesTerminalSession>((resolve, reject) => {
    let ws: WebSocket

    try {
      ws = new WebSocket(wsUrl)
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))

      return
    }

    ws.binaryType = 'arraybuffer'

    const session: IosPtySession = {
      buffer: [],
      closed: false,
      cwd: options?.cwd || '',
      dataListeners: new Set(),
      exitListeners: new Set(),
      flushed: false,
      shell: 'hermes',
      ws
    }

    let opened = false

    ws.onopen = () => {
      opened = true
      ptySessions.set(id, session)

      // Send the initial size so the remote PTY matches the xterm viewport.
      if (options?.cols && options?.rows) {
        try {
          ws.send(ptyResizeFrame(options.cols, options.rows))
        } catch {
          // Resize is best-effort; the first real fit() will retry.
        }
      }

      resolve({ id, shell: session.shell, cwd: session.cwd })
    }

    ws.onmessage = event => {
      const text = decodePtyMessage(event.data)

      if (text !== null) {
        emitPtyData(session, text)
      }
    }

    ws.onerror = () => {
      if (!opened) {
        reject(new Error('Could not open the remote terminal WebSocket.'))
      }
    }

    ws.onclose = event => {
      session.closed = true
      ptySessions.delete(id)

      for (const listener of [...session.exitListeners]) {
        try {
          listener({ code: event.code || null, signal: null })
        } catch {
          // ignore
        }
      }

      if (!opened) {
        reject(new Error(`The remote terminal closed before opening (code ${event.code}).`))
      }
    }
  })
}

const iosTerminal: NonNullable<Window['hermesDesktop']['terminal']> = {
  start: startPtySession,
  write: async (id, data) => {
    const session = ptySessions.get(id)

    if (!session || session.closed || session.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    try {
      session.ws.send(data)

      return true
    } catch {
      return false
    }
  },
  resize: async (id, size) => {
    const session = ptySessions.get(id)

    if (!session || session.closed || session.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    try {
      session.ws.send(ptyResizeFrame(size.cols, size.rows))

      return true
    } catch {
      return false
    }
  },
  onData: (id, callback) => {
    const session = ptySessions.get(id)

    if (!session) {
      return () => {}
    }

    session.dataListeners.add(callback)

    // Flush anything that arrived before the renderer attached.
    if (!session.flushed && session.buffer.length > 0) {
      session.flushed = true
      const pending = session.buffer.splice(0, session.buffer.length)

      for (const chunk of pending) {
        try {
          callback(chunk)
        } catch {
          // ignore
        }
      }
    }

    return () => void session.dataListeners.delete(callback)
  },
  onExit: (id, callback) => {
    const session = ptySessions.get(id)

    if (!session) {
      // Already gone — report an immediate exit on the next tick so the
      // caller's cleanup runs.
      queueMicrotask(() => callback({ code: null, signal: null }))

      return () => {}
    }

    session.exitListeners.add(callback)

    return () => void session.exitListeners.delete(callback)
  },
  dispose: async id => {
    const session = ptySessions.get(id)

    if (!session) {
      return true
    }

    session.closed = true
    ptySessions.delete(id)

    try {
      session.ws.close()
    } catch {
      // ignore
    }

    return true
  },
  cwd: async id => ptySessions.get(id)?.cwd || null
}

// ---------------------------------------------------------------------------
// Connection-config surface (Settings → Gateway + boot-failure recovery).
// ---------------------------------------------------------------------------

function connectionConfigFor(profile?: null | string): DesktopConnectionConfig {
  const key = scopeKey(profile)
  const config = readStoredConfig()
  const scope = (key ? config.profiles[key] : config.global) ?? null

  return {
    envOverride: false,
    mode: 'remote',
    profile: key,
    remoteAuthMode: scope?.remoteAuthMode === 'oauth' ? 'oauth' : 'token',
    remoteOauthConnected: Boolean(scope?.remoteOauthConnected),
    remoteTokenPreview: tokenPreview(scope?.remoteToken ?? ''),
    remoteTokenSet: Boolean(scope?.remoteToken),
    remoteUrl: scope?.remoteUrl ?? '',
    cloudOrg: ''
  }
}

function saveConnectionConfigInput(payload: DesktopConnectionConfigInput): DesktopConnectionConfig {
  if (payload.mode && payload.mode !== 'remote') {
    throw new Error('This Hermes build only supports remote gateway connections.')
  }

  const key = scopeKey(payload.profile)
  const config = readStoredConfig()
  const existing = (key ? config.profiles[key] : config.global) ?? null
  const remoteUrl = normalizeRemoteBaseUrl(payload.remoteUrl ?? existing?.remoteUrl ?? '')

  const remoteAuthMode =
    payload.remoteAuthMode === 'oauth'
      ? 'oauth'
      : payload.remoteAuthMode === 'token'
        ? 'token'
        : (existing?.remoteAuthMode ?? 'token')

  const next: StoredGatewayScope = {
    remoteUrl,
    remoteAuthMode,
    // An omitted token keeps the stored one (matches the desktop's "existing
    // token" placeholder behavior); an explicit empty string clears it.
    remoteToken:
      payload.remoteToken !== undefined
        ? payload.remoteToken
        : remoteUrl === existing?.remoteUrl
          ? (existing?.remoteToken ?? '')
          : '',
    remoteOauthConnected: remoteUrl === existing?.remoteUrl ? Boolean(existing?.remoteOauthConnected) : false
  }

  if (key) {
    config.profiles[key] = next
  } else {
    config.global = next
  }

  writeStoredConfig(config)
  log(`gateway config saved (scope=${key ?? 'global'}, url=${remoteUrl}, auth=${remoteAuthMode})`)

  return connectionConfigFor(key)
}

function setOauthConnected(rawUrl: string | undefined, connected: boolean) {
  const config = readStoredConfig()
  const url = rawUrl ? normalizeRemoteBaseUrl(rawUrl) : null

  const apply = (scope: StoredGatewayScope | null) => {
    if (scope && (!url || scope.remoteUrl === url)) {
      scope.remoteOauthConnected = connected

      // Signing out of an OAuth scope also drops the /app-connect token —
      // it's the session credential, not a user-entered value.
      if (!connected && scope.remoteAuthMode === 'oauth') {
        scope.remoteToken = ''
      }
    }
  }

  apply(config.global)

  for (const name of Object.keys(config.profiles)) {
    apply(config.profiles[name])
  }

  writeStoredConfig(config)
}

async function probeConnectionConfig(rawUrl: string): Promise<DesktopConnectionProbeResult> {
  let baseUrl: string

  try {
    baseUrl = normalizeRemoteBaseUrl(rawUrl)
  } catch (error) {
    return {
      baseUrl: String(rawUrl || ''),
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  let status: { auth_required?: boolean; version?: string } | null

  try {
    status = await fetchPublicJson(`${baseUrl}/api/status`)
  } catch (error) {
    return {
      baseUrl,
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  const authRequired = Boolean(status?.auth_required)
  let providers: DesktopAuthProvider[] = []

  if (authRequired) {
    try {
      const body = await fetchPublicJson<{ providers?: unknown[] }>(`${baseUrl}/api/auth/providers`)

      if (Array.isArray(body?.providers)) {
        providers = body.providers
          .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
          .map(p => ({
            name: String(p.name || ''),
            displayName: String(p.display_name || p.name || ''),
            supportsPassword: Boolean(p.supports_password)
          }))
          .filter(p => p.name)
      }
    } catch {
      // Provider listing is optional metadata; the auth mode is already known.
    }
  }

  return {
    baseUrl,
    reachable: true,
    authMode: authRequired ? 'oauth' : 'token',
    providers,
    version: status?.version ? String(status.version) : null,
    error: null
  }
}

async function testConnectionConfig(payload: DesktopConnectionConfigInput): Promise<DesktopConnectionTestResult> {
  const key = scopeKey(payload.profile)
  const stored = scopeFor(readStoredConfig(), key)
  const baseUrl = normalizeRemoteBaseUrl(payload.remoteUrl ?? stored?.remoteUrl ?? '')
  const authMode = payload.remoteAuthMode === 'oauth' ? 'oauth' : 'token'

  const scope: StoredGatewayScope = {
    remoteUrl: baseUrl,
    remoteAuthMode: authMode,
    remoteToken:
      payload.remoteToken !== undefined && payload.remoteToken !== ''
        ? payload.remoteToken
        : baseUrl === stored?.remoteUrl
          ? (stored?.remoteToken ?? '')
          : '',
    remoteOauthConnected: Boolean(stored?.remoteOauthConnected)
  }

  const status = await fetchGatewayJson<{ version?: string }>(`${baseUrl}/api/status`, scope, { timeoutMs: 8_000 })

  // The HTTP check proves reachability; the chat surface needs the /api/ws
  // WebSocket, a separate transport with separate guards. Exercise it too so
  // "Test connection" reflects the full path the app actually uses.
  let wsUrl: null | string = null

  if (authMode === 'oauth') {
    try {
      wsUrl = wsUrlFromBase(baseUrl, ['ticket', await mintWsTicket(scope)])
    } catch (error) {
      if (isAuthRejection(error)) {
        throw new Error(
          'Reached the gateway over HTTP, but the OAuth session was rejected while minting a WebSocket ticket. ' +
            'Open Settings → Gateway and sign in again.'
        )
      }

      throw new Error(
        'Reached the gateway over HTTP, but could not mint a WebSocket ticket. Check the remote gateway connection and try again.'
      )
    }
  } else if (scope.remoteToken) {
    wsUrl = wsUrlFromBase(baseUrl, ['token', scope.remoteToken])
  }

  if (wsUrl) {
    const probe = await probeGatewayWebSocket(wsUrl)

    if (!probe.ok) {
      throw new Error(
        `Reached the gateway over HTTP, but the live WebSocket (/api/ws) connection failed: ${probe.reason} ` +
          'The HTTP check can pass while the WebSocket is blocked by a proxy, firewall, or gateway auth/origin guard.'
      )
    }
  }

  return { ok: true, baseUrl, version: status?.version ? String(status.version) : null }
}

// OAuth sign-in without an Electron login window: navigate THIS WebView to
// the gateway's /app-connect page. Unauthenticated visits bounce through the
// normal /login flow (session cookies work on top-level navigations), and the
// authenticated landing redirects back to the app origin with the gateway's
// native-app token in the URL fragment — adopted by adoptAppConnectToken()
// when the app reloads. Requires a gateway new enough to serve /app-connect.
async function oauthLoginConnectionConfig(rawUrl: string): Promise<DesktopOauthLoginResult> {
  const baseUrl = normalizeRemoteBaseUrl(rawUrl)

  localStorage.setItem(OAUTH_PENDING_KEY, baseUrl)

  const returnUrl = `${window.location.origin}${window.location.pathname}`
  window.location.assign(`${baseUrl}/app-connect?return=${encodeURIComponent(returnUrl)}`)

  // The page is navigating away; keep the caller's await suspended so the
  // settings UI doesn't flash an "incomplete" state during the unload.
  return new Promise<DesktopOauthLoginResult>(() => {})
}

async function oauthLogoutConnectionConfig(rawUrl?: string): Promise<DesktopOauthLogoutResult> {
  const config = readStoredConfig()
  const url = rawUrl ? normalizeRemoteBaseUrl(rawUrl) : config.global?.remoteUrl

  if (url) {
    try {
      await fetch(`${url}/api/auth/logout`, { method: 'POST', credentials: 'include' })
    } catch {
      // Best-effort: clearing the local token/flag is the important part.
    }
  }

  setOauthConnected(url ?? undefined, false)

  return { ok: true, connected: false }
}

// The /app-connect return trip: the gateway redirected back to the app origin
// with `#hermes_app_token=…`. Adopt it into the pending OAuth scope (every
// scope pointing at that gateway URL), then scrub the fragment before the
// router mounts. Runs once at bridge install, BEFORE the app boots.
const OAUTH_PENDING_KEY = 'hermes-ios-oauth-pending'

function adoptAppConnectToken() {
  const match = /[#&]hermes_app_token=([^&]+)/.exec(window.location.hash)

  if (!match) {
    return
  }

  const token = decodeURIComponent(match[1])
  const pendingUrl = localStorage.getItem(OAUTH_PENDING_KEY)
  localStorage.removeItem(OAUTH_PENDING_KEY)
  history.replaceState(null, '', window.location.pathname + window.location.search)

  if (!token || !pendingUrl) {
    return
  }

  const config = readStoredConfig()

  const apply = (scope: StoredGatewayScope | null) => {
    if (scope && scope.remoteUrl === pendingUrl) {
      scope.remoteAuthMode = 'oauth'
      scope.remoteToken = token
      scope.remoteOauthConnected = true
    }
  }

  apply(config.global)

  for (const name of Object.keys(config.profiles)) {
    apply(config.profiles[name])
  }

  writeStoredConfig(config)
  log(`app-connect token adopted for ${pendingUrl}`)
}

// ---------------------------------------------------------------------------
// Connection resolution (the renderer's boot + reconnect path).
// ---------------------------------------------------------------------------

async function getConnection(profile?: null | string): Promise<HermesConnection> {
  const scope = requireScope(profile)

  const authParam: readonly [string, string] =
    scope.remoteAuthMode === 'oauth' ? ['ticket', ''] : ['token', scope.remoteToken]

  return {
    baseUrl: scope.remoteUrl,
    isFullscreen: true,
    mode: 'remote',
    authMode: scope.remoteAuthMode,
    nativeOverlayWidth: 0,
    source: 'settings',
    // OAuth scopes hold the /app-connect handout here; token scopes the
    // user-entered session token. Either way it's the REST credential.
    token: scope.remoteToken,
    // Fallback only — resolveGatewayWsUrl() always re-mints through
    // getGatewayWsUrl() before dialing.
    wsUrl: wsUrlFromBase(scope.remoteUrl, authParam),
    logs: [],
    ...(scopeKey(profile) ? { profile: scopeKey(profile)! } : {}),
    windowButtonPosition: null
  }
}

// ---------------------------------------------------------------------------
// Misc small surfaces.
// ---------------------------------------------------------------------------

const bootProgressSnapshot = (): DesktopBootProgress => ({
  error: null,
  fakeMode: false,
  message: '',
  phase: 'renderer.boot',
  progress: 0,
  running: false,
  timestamp: Date.now()
})

const bootstrapState = (): DesktopBootstrapState => ({
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  unsupportedPlatform: null
})

function previewTargetFor(target: string): HermesPreviewTarget | null {
  const trimmed = String(target || '').trim()

  if (!trimmed) {
    return null
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let label = trimmed

    try {
      label = new URL(trimmed).host
    } catch {
      // Keep the raw string as the label.
    }

    return { kind: 'url', label, previewKind: 'html', source: trimmed, url: trimmed }
  }

  // Remote file path: the preview pane reads content through the gateway's
  // /api/fs endpoints (desktop-fs remote mode), so only classification happens
  // here.
  const base = trimmed.split('/').pop() || trimmed
  const image = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(base)

  return {
    kind: 'file',
    label: base,
    path: trimmed,
    previewKind: image ? 'image' : 'text',
    renderMode: 'preview',
    source: trimmed,
    url: `file://${trimmed}`
  }
}

async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// Subscription surface with no events on iOS: accept the callback, hand back a
// working unsubscribe so `off()` cleanup calls stay safe.
const subscribeNoop =
  (..._args: unknown[]) =>
  () => {}

// ---------------------------------------------------------------------------
// The bridge object.
// ---------------------------------------------------------------------------

const bridge: Window['hermesDesktop'] = {
  gatewayOnly: true,

  getConnection,
  revalidateConnection: async () => {
    try {
      const scope = requireScope()
      await fetchGatewayJson(`${scope.remoteUrl}/api/status`, scope, { timeoutMs: 8_000 })

      return { ok: true, rebuilt: false }
    } catch {
      return { ok: false, rebuilt: false }
    }
  },
  touchBackend: async () => ({ ok: true }),
  getGatewayWsUrl: freshGatewayWsUrl,

  openSessionWindow: async () => ({ ok: false, error: 'Multi-window is not available on iOS.' }),
  openWindow: async () => ({ ok: false, error: 'Multi-window is not available on iOS.' }),
  claimAmbientCue: async () => true,

  getBootProgress: async () => bootProgressSnapshot(),

  getConnectionConfig: async profile => connectionConfigFor(profile),
  saveConnectionConfig: async payload => saveConnectionConfigInput(payload),
  applyConnectionConfig: async payload => {
    const config = saveConnectionConfigInput(payload)
    // Soft gateway apply: the boot hook wipes gateway-bound stores and
    // re-dials in place (same contract as Electron's onConnectionApplied).
    queueMicrotask(() => connectionApplied.emit())

    return config
  },
  testConnectionConfig,
  probeConnectionConfig,
  oauthLoginConnectionConfig,
  oauthLogoutConnectionConfig,

  profile: {
    get: async (): Promise<DesktopActiveProfile> => ({ profile: localStorage.getItem(PROFILE_KEY) || null }),
    set: async (name: string | null): Promise<DesktopActiveProfile> => {
      if (name) {
        localStorage.setItem(PROFILE_KEY, name)
      } else {
        localStorage.removeItem(PROFILE_KEY)
      }

      // The desktop relaunches + reloads on a profile change; mirror the
      // reload so every store re-homes onto the new profile scope.
      setTimeout(() => window.location.reload(), 50)

      return { profile: name }
    }
  },

  api: gatewayApi,

  terminal: iosTerminal,

  notify: async (payload: HermesNotification) => {
    // Native iOS local notifications through the CapacitorLocalNotifications
    // pod. `Capacitor.Plugins.LocalNotifications` only exists when the
    // plugin's JS package is imported by the bundle (registerPlugin), which
    // this desktop-first bundle never does — so call the native side through
    // the low-level `Capacitor.nativePromise(plugin, method, options)` the
    // injected native-bridge always provides (the same seam CapacitorHttp's
    // fetch patch uses). First use triggers the system permission prompt; a
    // denied permission makes notify() report false so the renderer's "not
    // supported" copy stays honest.
    const capacitor = (
      window as {
        Capacitor?: {
          nativePromise?: <T>(pluginName: string, methodName: string, options?: unknown) => Promise<T>
        }
      }
    ).Capacitor

    if (typeof capacitor?.nativePromise === 'function') {
      const call = <T>(method: string, options?: unknown) =>
        capacitor.nativePromise!<T>('LocalNotifications', method, options)

      let step = 'checkPermissions'

      try {
        let permission = await call<{ display: string }>('checkPermissions')
        const initialState = permission.display

        if (permission.display === 'prompt' || permission.display === 'prompt-with-rationale') {
          step = 'requestPermissions'
          permission = await call<{ display: string }>('requestPermissions')
        }

        if (permission.display !== 'granted') {
          lastNotifyDiagnostic =
            `Notification permission is "${permission.display}" (started as "${initialState}"). ` +
            'iOS is blocking notifications for the app that hosts Hermes: open iOS Settings → Notifications, ' +
            'find the host app (e.g. LiveContainer), and enable Allow Notifications — then retry.'
          log(`local notification skipped: ${lastNotifyDiagnostic}`)

          return false
        }

        step = 'schedule'
        await call('schedule', {
          notifications: [
            {
              // Int32 range, unique enough for fire-and-forget alerts.
              id: Date.now() % 2_147_483_647,
              title: payload.title || 'Hermes',
              body: payload.body || '',
              ...(payload.silent ? {} : { sound: 'default' })
            }
          ]
        })

        lastNotifyDiagnostic =
          'Native notification scheduled (permission granted). If no banner appeared while the app was open, ' +
          'the host app is suppressing foreground banners — check the iOS Notification Center, or background ' +
          'Hermes before the next alert fires.'

        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        // UNErrorDomain error 1 = UNErrorCodeNotificationsNotAllowed: iOS
        // refused the registration itself. Inside app-container hosts
        // (LiveContainer) this is structural — the guest app's bundle id is
        // not a real installed app, so the OS rejects it no matter what the
        // Settings toggle says. Only a real (signed) install can fix it.
        lastNotifyDiagnostic = message.includes('UNErrorDomain error 1')
          ? `LocalNotifications.${step} failed: iOS refused notification registration (UNErrorDomain error 1). ` +
            'This is a limitation of running inside an app container like LiveContainer — the hosted app is not ' +
            'a real installed app, so iOS rejects its notification requests regardless of the Settings toggle. ' +
            'Installing the IPA as a real app (AltStore / Sideloadly signing) makes notifications work.'
          : `LocalNotifications.${step} failed: ${message || 'unknown native error'}.`
        log(`local notification failed: ${lastNotifyDiagnostic}`)

        return false
      }
    }

    // Browser fallback (dev/preview outside the native shell).
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      lastNotifyDiagnostic =
        'The Capacitor native bridge is not available (running outside the iOS shell) and the browser ' +
        `Notification API is ${typeof Notification === 'undefined' ? 'missing' : 'not granted'}.`

      return false
    }

    try {
      new Notification(payload.title || 'Hermes', { body: payload.body || '', silent: Boolean(payload.silent) })
      lastNotifyDiagnostic = 'Browser notification shown (web fallback).'

      return true
    } catch (error) {
      lastNotifyDiagnostic = `Browser notification failed: ${error instanceof Error ? error.message : String(error)}`

      return false
    }
  },
  notifyDiagnostics: async () => lastNotifyDiagnostic,
  requestMicrophoneAccess: async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => track.stop())

      return true
    } catch {
      return false
    }
  },

  biometric: {
    getAvailability: async () => {
      const info = (window as { __hermesBiometric?: { available?: boolean; biometryType?: string; enabled?: boolean } })
        .__hermesBiometric

      return {
        available: Boolean(info?.available),
        biometryType: typeof info?.biometryType === 'string' ? info.biometryType : 'none',
        enabled: Boolean(info?.enabled ?? localStorage.getItem(BIOMETRIC_LOCK_KEY) === '1')
      }
    },
    setEnabled: async (enabled: boolean) => {
      try {
        const handler = (
          window as { webkit?: { messageHandlers?: { hermesBiometric?: { postMessage: (msg: unknown) => void } } } }
        ).webkit?.messageHandlers?.hermesBiometric

        handler?.postMessage({ enabled })

        const info = (window as { __hermesBiometric?: { enabled?: boolean } }).__hermesBiometric

        if (info) {
          info.enabled = enabled
        }

        localStorage.setItem(BIOMETRIC_LOCK_KEY, enabled ? '1' : '0')

        return true
      } catch {
        return false
      }
    }
  },

  readFileDataUrl: async (filePath: string) => {
    const result = await gatewayApi<string | { dataUrl?: string }>({
      path: `/api/fs/read-data-url?path=${encodeURIComponent(filePath)}`
    })

    return typeof result === 'string' ? result : result?.dataUrl || ''
  },
  readFileText: (filePath: string) =>
    gatewayApi<HermesReadFileTextResult>({ path: `/api/fs/read-text?path=${encodeURIComponent(filePath)}` }),
  readDir: (path: string) => gatewayApi<HermesReadDirResult>({ path: `/api/fs/list?path=${encodeURIComponent(path)}` }),
  gitRoot: async (path: string) =>
    (await gatewayApi<{ root: null | string }>({ path: `/api/fs/git-root?path=${encodeURIComponent(path)}` })).root,

  selectPaths: async () => [],
  writeClipboard: async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)

      return true
    } catch {
      return false
    }
  },
  saveImageFromUrl: async (url: string) => {
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      await downloadBlob(blob, url.split('/').pop()?.split('?')[0] || 'image.png')

      return true
    } catch {
      return false
    }
  },
  saveImageBuffer: async (data: ArrayBuffer | Uint8Array, ext: string) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    const filename = `hermes-image.${ext.replace(/^\./, '') || 'png'}`
    await downloadBlob(new Blob([bytes as BlobPart]), filename)

    return filename
  },
  saveClipboardImage: async () => '',
  getPathForFile: () => '',

  normalizePreviewTarget: async (target: string) => previewTargetFor(target),
  watchPreviewFile: async (url: string) => ({ id: `ios-${Date.now()}`, path: url }),
  stopPreviewFileWatch: async () => true,

  setKeepAwake: (on: boolean) => {
    keepAwakeWanted = on

    if (on) {
      void acquireWakeLock()
    } else {
      void releaseWakeLock()
    }
  },

  openExternal: async (url: string) => {
    window.open(url, '_blank')
  },
  openPreviewInBrowser: async (url: string) => {
    window.open(url, '_blank')
  },
  fetchLinkTitle: async (url: string) => {
    try {
      const response = await fetch(url, { credentials: 'omit' })
      const text = await response.text()
      const match = /<title[^>]*>([^<]*)<\/title>/i.exec(text)

      return match ? match[1].trim() : ''
    } catch {
      return ''
    }
  },
  sanitizeWorkspaceCwd: async (cwd?: null | string) => ({ cwd: cwd || '', sanitized: false }),

  settings: {
    getDefaultProjectDir: async () => {
      const dir = localStorage.getItem(PROJECT_DIR_KEY)

      return { defaultLabel: dir || '', dir: dir || null, resolvedCwd: dir || '' }
    },
    pickDefaultProjectDir: async () => ({ canceled: true, dir: null }),
    setDefaultProjectDir: async (dir: null | string) => {
      if (dir) {
        localStorage.setItem(PROJECT_DIR_KEY, dir)
      } else {
        localStorage.removeItem(PROJECT_DIR_KEY)
      }

      return { dir }
    }
  },

  revealLogs: async () => ({ ok: false, path: '', error: 'Log files are not available on iOS.' }),
  getRecentLogs: async () => ({ path: '', lines: [...recentLogs] }),

  onPreviewFileChanged: subscribeNoop,
  onBackendExit: subscribeNoop,
  onConnectionApplied: (callback: () => void) => connectionApplied.on(callback),
  onPowerResume: (callback: () => void) => powerResume.on(callback),
  onBootProgress: subscribeNoop,

  getBootstrapState: async () => bootstrapState(),
  resetBootstrap: async () => ({ ok: true }),
  repairBootstrap: async () => ({ ok: true }),
  cancelBootstrap: async () => ({ ok: true, cancelled: false }),
  onBootstrapEvent: subscribeNoop,

  getVersion: async () => ({
    appVersion: `${import.meta.env.VITE_HERMES_IOS_VERSION || '0.0.0'}-ios`,
    electronVersion: '',
    nodeVersion: '',
    platform: 'ios',
    hermesRoot: ''
  }),
  getRemoteDisplayReason: async () => null
}

// Pick up an /app-connect return (OAuth sign-in round trip) before the app
// boots, so getConnection() already sees the adopted token.
adoptAppConnectToken()

window.hermesDesktop = bridge
log('iOS gateway bridge installed')

// Migrate the session token into the iOS Keychain in the BACKGROUND — never
// gate boot on it. Until it completes the token is still read from
// localStorage (the overlay cache is simply empty), so the first
// getConnection() resolves either way. Gating startup on this async native
// call risked a blank page if the Keychain call stalled inside a host
// container (e.g. LiveContainer).
void hydrateSecureTokens().catch(() => undefined)
