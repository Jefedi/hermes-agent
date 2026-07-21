import UIKit
import Capacitor

/// Bridge view controller that keeps the WKWebView inside the device's safe
/// area (status bar / Dynamic Island at the top, home indicator at the
/// bottom, notch edges in landscape).
///
/// In Capacitor, `loadView()` makes the webview ITSELF the controller's root
/// view (`view = webView`), and a root view is always pinned to the full
/// window by UIKit — it cannot be inset in place (constraining it to its own
/// safe-area guide is a no-op, and re-framing it against itself shrinks it
/// recursively). So this controller re-parents: a plain container becomes the
/// root view, the webview moves inside it, pinned to the container's
/// safe-area layout guide. The uncovered bands show the container's
/// background, kept in sync with the system light/dark appearance to match
/// the app theme's boot background (#f7f7f7 / #111111).
///
/// The page-side CSS in apps/desktop/src/ios/ios.css keeps its own
/// env(safe-area-inset-*) handling as a fallback; with the webview confined
/// here those insets are all 0, so the two layers compose instead of
/// double-insetting.
class SafeAreaViewController: CAPBridgeViewController {

    private static let themeBackground = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x11 / 255.0, green: 0x11 / 255.0, blue: 0x11 / 255.0, alpha: 1)
            : UIColor(red: 0xF7 / 255.0, green: 0xF7 / 255.0, blue: 0xF7 / 255.0, alpha: 1)
    }

    override func viewDidLoad() {
        // Runs after loadView(), so `view === webView` at this point and the
        // web content is already loading.
        super.viewDidLoad()

        guard let webView = self.webView, view === webView else {
            return
        }

        let container = UIView(frame: webView.bounds)
        container.backgroundColor = Self.themeBackground

        view = container
        container.addSubview(webView)

        webView.backgroundColor = Self.themeBackground
        webView.scrollView.backgroundColor = Self.themeBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: container.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.safeAreaLayoutGuide.trailingAnchor)
        ])
    }
}
