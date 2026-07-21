import UIKit
import Capacitor

/// Bridge view controller that keeps the WKWebView inside the device's safe
/// area (status bar / Dynamic Island at the top, home indicator at the
/// bottom, notch edges in landscape).
///
/// The stock Capacitor controller stretches the webview edge-to-edge and
/// relies on the page's `env(safe-area-inset-*)` CSS to pad content back
/// inside — which the Hermes renderer (a desktop-first app full of
/// fixed-position chrome) can't honour reliably, leaving the titlebar
/// buttons unreachable behind the clock/battery. Constraining the webview
/// natively is deterministic: the page simply never extends under system UI.
///
/// The uncovered bands show this controller's view background, kept in sync
/// with the system light/dark appearance to match the app theme's boot
/// background (#f7f7f7 / #111111).
class SafeAreaViewController: CAPBridgeViewController {

    private static let themeBackground = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x11 / 255.0, green: 0x11 / 255.0, blue: 0x11 / 255.0, alpha: 1)
            : UIColor(red: 0xF7 / 255.0, green: 0xF7 / 255.0, blue: 0xF7 / 255.0, alpha: 1)
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = Self.themeBackground

        if let webView = self.webView {
            webView.backgroundColor = Self.themeBackground
            webView.scrollView.backgroundColor = Self.themeBackground
            // Frame-driven layout below; flexible autoresizing would fight it
            // on rotation.
            webView.autoresizingMask = []
        }
    }

    // Enforce the safe-area frame on EVERY layout pass (initial load, safe
    // area becoming known, rotations, size-class changes). Frame assignment
    // beats Auto Layout constraints here: Capacitor owns the webview and
    // re-frames it to the full bounds itself, so a one-shot constraint setup
    // can be silently overridden — this cannot.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()

        guard let webView = self.webView else {
            return
        }

        let target = view.safeAreaLayoutGuide.layoutFrame

        if !target.isEmpty && webView.frame != target {
            webView.frame = target
        }
    }
}
