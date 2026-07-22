/**
 * iOS entry point. Import order matters: the gateway bridge must install
 * `window.hermesDesktop` before any of the app's modules evaluate (several
 * stores read the bridge at module scope), so `./bridge` comes first.
 */
import './ios.css'

import { whenBridgeReady } from './bridge'

// Wait for the Keychain token migration to finish before booting, so the
// first connection resolve already reads the secured token. `whenBridgeReady`
// never rejects. Top-level await is supported by the ESM build target.
await whenBridgeReady
await import('../main')
