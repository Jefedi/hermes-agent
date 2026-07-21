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

        guard let webView = self.webView else {
            return
        }

        webView.backgroundColor = Self.themeBackground
        webView.scrollView.backgroundColor = Self.themeBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
    }
}
