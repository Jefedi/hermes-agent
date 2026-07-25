/**
 * ios-gestures.ts — touch gesture layer for the iOS shell.
 *
 * Adds edge-swipe-to-open and swipe-to-close for the sidebar and file browser
 * overlays, mirroring the iOS native back/forward gesture pattern (like
 * ChatGPT iOS, Apple Mail, Notes). Hooks into the existing
 * PANE_TOGGLE_REVEAL_EVENT mechanism so no React component changes are needed.
 *
 * Gestures:
 * - Swipe right from left edge → open sessions sidebar
 * - Swipe left from right edge → open file browser
 * - Swipe left when sidebar is open → close sidebar
 * - Swipe right when file browser is open → close file browser
 * - Swipe down from top-center → close any open overlay
 * - Tap on scrim (backdrop) → close open overlay
 *
 * Also syncs `data-ios-drawer-open` on the body so the CSS can show the scrim.
 *
 * Imported for side effect from ios/main.tsx, AFTER bridge.ts and BEFORE ../main.
 */

import { PANE_TOGGLE_REVEAL_EVENT } from '@/components/pane-shell'
import { CHAT_SIDEBAR_PANE_ID, FILE_BROWSER_PANE_ID } from '@/store/layout'
import { $sidebarOpen, $fileBrowserOpen } from '@/store/layout'

// --- Configuration --------------------------------------------------------

/** Width of the edge zone where a swipe originates (px from screen edge). */
const EDGE_ZONE_WIDTH = 28

/** Minimum horizontal travel to qualify as a swipe (px). */
const SWIPE_MIN_DISTANCE = 50

/** Maximum vertical drift for a horizontal swipe (px). */
const SWIPE_MAX_VERTICAL_DRIFT = 60

/** Maximum gesture duration (ms). */
const SWIPE_MAX_DURATION = 600

/** Velocity threshold (px/ms) — fast flick can cover less distance. */
const SWIPE_VELOCITY_THRESHOLD = 0.4

/** Top zone height for swipe-down-to-close (px from top, after safe area). */
const TOP_CLOSE_ZONE_HEIGHT = 60

// --- Touch tracking -------------------------------------------------------

interface TouchTrack {
  startX: number
  startY: number
  startTime: number
  edge: 'left' | 'right' | null
  topZone: boolean
  horizontal: boolean | null
  committed: boolean
}

let track: TouchTrack | null = null

// --- Pane state -----------------------------------------------------------

function sidebarOpen(): boolean {
  return $sidebarOpen.get()
}

function fileBrowserOpen(): boolean {
  return $fileBrowserOpen.get()
}

function anyOverlayOpen(): boolean {
  return sidebarOpen() || fileBrowserOpen()
}

// --- Drawer state sync ----------------------------------------------------

function syncDrawerState() {
  const open = anyOverlayOpen()
  document.body.dataset.iosDrawerOpen = String(open)
}

// Subscribe to pane state changes so the CSS scrim appears/disappears
// in sync with the store (not just with gestures).
function subscribeToPaneState() {
  // Use nanostores' listen pattern (not React) for side-effect-only subscription
  const unsub1 = $sidebarOpen.listen(syncDrawerState)
  const unsub2 = $fileBrowserOpen.listen(syncDrawerState)
  // Initial sync
  syncDrawerState()
  // Keep subscriptions alive for the lifetime of the page
  // (no cleanup needed — this is a singleton gesture layer)
  void unsub1
  void unsub2
}

// --- Event dispatch -------------------------------------------------------

function revealPane(id: string, mode: 'open' | 'close' | 'toggle') {
  window.dispatchEvent(new CustomEvent(PANE_TOGGLE_REVEAL_EVENT, { detail: { id, mode } }))
}

// --- Scrim tap-to-close --------------------------------------------------

/**
 * When a drawer is open, tapping outside the drawer (on the scrim) closes it.
 * We detect this by checking if the tap landed on the body::after pseudo-element
 * (the scrim) or on a non-drawer element.
 */
function onScrimClick(event: MouseEvent) {
  if (!anyOverlayOpen()) return

  // Check if the click target is inside a drawer pane — if so, let it through
  const target = event.target as HTMLElement | null
  if (!target) return

  const drawer = target.closest('[data-pane-id="chat-sidebar"], [data-pane-id="file-browser"]')
  if (drawer) return // click inside a drawer, let it handle normally

  // Click outside drawers → close whichever is open
  if (sidebarOpen()) revealPane(CHAT_SIDEBAR_PANE_ID, 'close')
  if (fileBrowserOpen()) revealPane(FILE_BROWSER_PANE_ID, 'close')
}

// --- Touch handlers -------------------------------------------------------

function onTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    track = null
    return
  }

  const t = event.touches[0]
  const safeTopRaw = getComputedStyle(document.body).getPropertyValue('--ios-safe-top') || '0px'
  const safeTopPx = parseInt(safeTopRaw, 10) || 0

  track = {
    startX: t.clientX,
    startY: t.clientY,
    startTime: Date.now(),
    edge: t.clientX <= EDGE_ZONE_WIDTH ? 'left' : t.clientX >= window.innerWidth - EDGE_ZONE_WIDTH ? 'right' : null,
    topZone: t.clientY - safeTopPx <= TOP_CLOSE_ZONE_HEIGHT && t.clientX > EDGE_ZONE_WIDTH && t.clientX < window.innerWidth - EDGE_ZONE_WIDTH,
    horizontal: null,
    committed: false
  }
}

function onTouchMove(_event: TouchEvent) {
  if (!track) return
  if (_event.touches.length !== 1) {
    track = null
    return
  }

  const t = _event.touches[0]
  const dx = t.clientX - track.startX
  const dy = t.clientY - track.startY

  if (track.horizontal === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
    track.horizontal = Math.abs(dx) > Math.abs(dy)
  }

  // Once classified as vertical (and not in top-close zone), abandon.
  if (!track.horizontal && !track.topZone) {
    track = null
  }
}

function onTouchEnd(event: TouchEvent) {
  if (!track) return

  const ct = event.changedTouches[0]
  if (!ct) {
    track = null
    return
  }

  const dx = ct.clientX - track.startX
  const dy = ct.clientY - track.startY
  const elapsed = Date.now() - track.startTime
  const velocity = elapsed > 0 ? Math.abs(dx) / elapsed : 0

  const tr = track
  track = null

  // --- Swipe-down from top zone → close any overlay ----------------------
  if (tr.topZone && dy > SWIPE_MIN_DISTANCE && Math.abs(dx) < SWIPE_MAX_VERTICAL_DRIFT) {
    if (anyOverlayOpen()) {
      if (sidebarOpen()) revealPane(CHAT_SIDEBAR_PANE_ID, 'close')
      if (fileBrowserOpen()) revealPane(FILE_BROWSER_PANE_ID, 'close')
    }
    return
  }

  if (!tr.horizontal) return
  if (Math.abs(dy) > SWIPE_MAX_VERTICAL_DRIFT) return
  if (elapsed > SWIPE_MAX_DURATION) return
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE && velocity < SWIPE_VELOCITY_THRESHOLD) return

  const swipingRight = dx > 0
  const swipingLeft = dx < 0

  // Edge swipe from left → open sidebar
  if (tr.edge === 'left' && swipingRight && !sidebarOpen()) {
    revealPane(CHAT_SIDEBAR_PANE_ID, 'open')
    return
  }

  // Edge swipe from right → open file browser
  if (tr.edge === 'right' && swipingLeft && !fileBrowserOpen()) {
    revealPane(FILE_BROWSER_PANE_ID, 'open')
    return
  }

  // Swipe left → close sidebar
  if (swipingLeft && sidebarOpen()) {
    revealPane(CHAT_SIDEBAR_PANE_ID, 'close')
    return
  }

  // Swipe right → close file browser
  if (swipingRight && fileBrowserOpen()) {
    revealPane(FILE_BROWSER_PANE_ID, 'close')
    return
  }
}

// --- Install --------------------------------------------------------------

function install() {
  // Touch gestures
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })
  document.addEventListener('touchcancel', () => { track = null }, { passive: true })

  // Scrim tap-to-close (mouse/touch click on the backdrop)
  document.addEventListener('click', onScrimClick, { passive: true })

  // Subscribe to pane store changes for CSS scrim sync
  subscribeToPaneState()
}

// Defer install until DOM is ready (the gesture layer loads before the renderer)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true })
} else {
  install()
}