import UIKit
import Capacitor
import LocalAuthentication
import WebKit

/// Bridge view controller that (1) keeps the WKWebView inside the device's
/// safe area and (2) optionally gates the app behind a biometric (Face ID /
/// Touch ID) unlock.
///
/// Safe area: in Capacitor, `loadView()` makes the webview ITSELF the
/// controller's root view (`view = webView`), and a root view is always
/// pinned to the full window by UIKit — it cannot be inset in place. So this
/// controller re-parents: a plain container becomes the root view, the
/// webview moves inside it, pinned to the container's safe-area layout guide.
/// The uncovered bands show the container's background, kept in sync with the
/// system light/dark appearance. The page-side CSS in
/// apps/desktop/src/ios/ios.css keeps env(safe-area-inset-*) as a composing
/// fallback (those insets are 0 once the webview is confined here).
///
/// Biometric lock: implemented with Apple's LocalAuthentication directly (no
/// Capacitor plugin, so no version-alignment risk). It is opt-in — a
/// `UserDefaults` flag the web toggles through the `hermesBiometric` message
/// handler. Availability + current state are injected into the page at
/// document-start as `window.__hermesBiometric` so the settings toggle only
/// shows when biometry is enrolled. `.deviceOwnerAuthentication` allows the
/// device passcode as a fallback, so the user can never be locked out.
class SafeAreaViewController: CAPBridgeViewController, WKScriptMessageHandler {

    static let lockDefaultsKey = "hermes_biometric_lock_enabled"

    private var lockOverlay: UIView?
    private var authInProgress = false
    private var unlockedThisForeground = false

    private static let themeBackground = UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0x11 / 255.0, green: 0x11 / 255.0, blue: 0x11 / 255.0, alpha: 1)
            : UIColor(red: 0xF7 / 255.0, green: 0xF7 / 255.0, blue: 0xF7 / 255.0, alpha: 1)
    }

    // MARK: - Webview configuration (inject biometry state + message handler)

    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        var typeString = "none"
        let available = Self.biometryAvailable(typeString: &typeString)
        let enabled = UserDefaults.standard.bool(forKey: Self.lockDefaultsKey)

        let js = """
        window.__hermesBiometric = {
          available: \(available ? "true" : "false"),
          biometryType: "\(typeString)",
          enabled: \(enabled ? "true" : "false")
        };
        """
        let script = WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(script)
        configuration.userContentController.add(self, name: "hermesBiometric")

        return WKWebView(frame: frame, configuration: configuration)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hermesBiometric",
              let body = message.body as? [String: Any],
              let enabled = body["enabled"] as? Bool else {
            return
        }
        UserDefaults.standard.set(enabled, forKey: Self.lockDefaultsKey)
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        // Runs after loadView(), so `view === webView` at this point.
        super.viewDidLoad()

        if let webView = self.webView, view === webView {
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

        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        lockIfNeeded()
    }

    @objc private func appWillResignActive() {
        // Re-arm on backgrounding and cover the content so it isn't exposed in
        // the app switcher — but never during the Face ID sheet's own resign
        // (that would ping-pong the prompt).
        if authInProgress { return }
        unlockedThisForeground = false
        if lockEnabled() {
            showLockOverlay()
        }
    }

    @objc private func appDidBecomeActive() {
        lockIfNeeded()
    }

    // MARK: - Biometric gate

    private static func biometryAvailable(typeString: inout String) -> Bool {
        let context = LAContext()
        var error: NSError?
        let ok = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        if ok {
            switch context.biometryType {
            case .faceID: typeString = "faceID"
            case .touchID: typeString = "touchID"
            default: typeString = "unknown"
            }
        }
        return ok
    }

    private func lockEnabled() -> Bool {
        guard UserDefaults.standard.bool(forKey: Self.lockDefaultsKey) else { return false }
        var ignored = "none"
        return Self.biometryAvailable(typeString: &ignored)
    }

    private func lockIfNeeded() {
        guard lockEnabled() else {
            hideLockOverlay()
            return
        }
        if unlockedThisForeground { return }
        showLockOverlay()
        authenticate()
    }

    private func authenticate() {
        if authInProgress { return }
        authInProgress = true

        let context = LAContext()
        // Allows the device passcode as a fallback so the user can't be locked
        // out if biometry fails repeatedly.
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Hermes") { [weak self] success, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.authInProgress = false
                if success {
                    self.unlockedThisForeground = true
                    self.hideLockOverlay()
                }
                // On failure the overlay stays; the user can tap Unlock again.
            }
        }
    }

    // MARK: - Lock overlay

    private func showLockOverlay() {
        if lockOverlay != nil { return }

        let overlay = UIView(frame: view.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = Self.themeBackground

        let button = UIButton(type: .system)
        button.setTitle("Unlock Hermes", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        button.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        overlay.addSubview(button)
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            button.centerYAnchor.constraint(equalTo: overlay.centerYAnchor)
        ])

        view.addSubview(overlay)
        lockOverlay = overlay
    }

    @objc private func retryTapped() {
        authenticate()
    }

    private func hideLockOverlay() {
        lockOverlay?.removeFromSuperview()
        lockOverlay = nil
    }
}
