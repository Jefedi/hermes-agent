/**
 * ios/main.tsx — iOS entry point (enhanced with gesture layer).
 *
 * Import order matters: the gateway bridge must install `window.hermesDesktop`
 * (side effect of importing `./bridge`) before any of the app's modules
 * evaluate — several stores read the bridge at module scope — so `./bridge`
 * comes before `../main`.
 *
 * Boot is NOT gated on the Keychain token migration: that runs in the
 * background from within `./bridge`.
 *
 * The gesture layer (`./ios-gestures`) is imported AFTER the bridge (it reads
 * layout stores) but BEFORE `../main` (so listeners are installed before the
 * renderer mounts and starts dispatching events).
 *
 * The keyboard observer is also installed here, before the app boots, so the
 * composer stays visible from the first frame when the keyboard opens.
 */

import './ios.css'
import './bridge'
import './ios-gestures'
import './ios-keyboard'
import '../main'