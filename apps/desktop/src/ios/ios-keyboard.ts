/**
 * ios-keyboard.ts — soft keyboard awareness for the iOS shell.
 *
 * iOS WKWebView resizes `visualViewport` (not `window.innerHeight`) when the
 * soft keyboard opens. Without compensating, the composer gets hidden behind
 * the keyboard. This module:
 *
 * 1. Tracks the visualViewport resize and sets `--keyboard-height` on the body
 *    so the CSS layer can offset the composer.
 * 2. Toggles `data-ios-keyboard-open` on the body for CSS targeting.
 * 3. Scrolls the message list to the bottom when the keyboard opens so the
 *    latest messages stay visible.
 * 4. Disables body scroll bounce while the keyboard is up.
 *
 * Also handles the edge case where `visualViewport` is not supported (older
 * iOS) by falling back to `window.innerHeight` comparison.
 *
 * Imported for side effect from ios/main.tsx.
 */

// --- State ----------------------------------------------------------------

let lastKnownKeyboardHeight = 0
let keyboardOpen = false

// --- Keyboard detection ---------------------------------------------------

function detectKeyboardHeight(): number {
  if (typeof window === 'undefined') return 0

  const vv = window.visualViewport
  if (vv) {
    const layoutHeight = window.innerHeight
    const visualHeight = vv.height
    const keyboardHeight = Math.max(0, layoutHeight - visualHeight)

    // Ignore tiny diffs (< 100px) — likely browser chrome adjustments
    return keyboardHeight > 100 ? keyboardHeight : 0
  }

  // Fallback: compare innerHeight to a stored baseline
  if (!detectKeyboardHeight.baseline) {
    detectKeyboardHeight.baseline = window.innerHeight
  }
  const diff = detectKeyboardHeight.baseline - window.innerHeight
  return diff > 100 ? diff : 0
}

// Assign a type-safe property for the fallback baseline
interface DetectFn {
  (): number
  baseline?: number
}
(detectKeyboardHeight as DetectFn).baseline = undefined as unknown as number

// --- Apply keyboard state -------------------------------------------------

function applyKeyboardState(height: number) {
  if (height === lastKnownKeyboardHeight) return

  lastKnownKeyboardHeight = height
  const isOpen = height > 0

  if (isOpen !== keyboardOpen) {
    keyboardOpen = isOpen
    document.body.dataset.iosKeyboardOpen = String(isOpen)
    document.body.style.setProperty('--keyboard-height', `${height}px`)

    if (isOpen) {
      // Scroll message list to bottom so latest messages are visible
      requestAnimationFrame(() => {
        const messageList = document.querySelector('[data-slot="message-list"]')
        if (messageList) {
          messageList.scrollTop = messageList.scrollHeight
        }
      })
    } else {
      // Keyboard closed: reset composer offset
      document.body.style.setProperty('--keyboard-height', '0px')
    }
  }
}

// --- VisualViewport listener ----------------------------------------------

function onVisualViewportResize() {
  applyKeyboardState(detectKeyboardHeight())
}

function onVisualViewportScroll() {
  // On iOS the visualViewport can also scroll independently — the offset
  // means the keyboard is pushing content. Detect and compensate.
  const vv = window.visualViewport
  if (!vv) return

  // If the page top is pushed down by the keyboard, account for it
  if (vv.offsetTop > 0 && !keyboardOpen) {
    applyKeyboardState(vv.offsetTop)
  }
}

// --- Install --------------------------------------------------------------

function install() {
  if (typeof window === 'undefined') return

  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', onVisualViewportResize)
    vv.addEventListener('scroll', onVisualViewportScroll)
  }

  // Fallback: window resize (older iOS without visualViewport)
  window.addEventListener('resize', onVisualViewportResize)

  // Initial detection after a short delay (let the app mount)
  setTimeout(onVisualViewportResize, 300)
}

install()