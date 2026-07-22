/**
 * iOS entry point. Import order matters: the gateway bridge must install
 * `window.hermesDesktop` (side effect of importing `./bridge`) before any of
 * the app's modules evaluate — several stores read the bridge at module scope
 * — so `./bridge` comes before `../main`.
 *
 * Boot is NOT gated on the Keychain token migration: that runs in the
 * background from within `./bridge`, and until it completes the token is
 * still read from localStorage, so the first connection resolves fine either
 * way. (Gating boot on an async native call risked a blank page if the
 * Keychain call ever stalled inside a host container.)
 */
import './ios.css'
import './bridge'
import '../main'
