/**
 * iOS entry point. Import order matters: the gateway bridge must install
 * `window.hermesDesktop` before any of the app's modules evaluate (several
 * stores read the bridge at module scope), so `./bridge` comes first.
 */
import './bridge'
import './ios.css'
import '../main'
