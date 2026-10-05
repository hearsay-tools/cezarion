import UIKit
import WebKit

final class CockpitController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let connection: Connection
    private var web: WKWebView!
    private let status = UILabel()
    private var loadWatchdog: Timer?
    private var failed = false
    init(connection: Connection) { self.connection = connection; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Servers", style: .plain, target: self, action: #selector(close))
        navigationItem.rightBarButtonItems = [
            UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reload)),
            UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(back))
        ]
        title = URL(string: connection.endpoint)?.host
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // No script message handlers or native bridge are granted to remote content.
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.translatesAutoresizingMaskIntoConstraints = false
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .systemOrange
        status.accessibilityIdentifier = "connectionStatus"
        status.setContentCompressionResistancePriority(.required, for: .vertical)
        status.isHidden = true
        let stack = UIStackView(arrangedSubviews: [status, web])
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
        reload()
    }

    deinit { loadWatchdog?.invalidate(); NotificationCenter.default.removeObserver(self) }
    @objc private func close() {
        loadWatchdog?.invalidate()
        NotificationCenter.default.removeObserver(self)
        web.stopLoading()
        web.navigationDelegate = nil; web.uiDelegate = nil
        web.removeFromSuperview(); web = nil
        navigationController?.popViewController(animated: true)
    }
    @objc private func back() { if web.canGoBack { web.goBack() } }
    @objc private func reload() {
        status.isHidden = true
        failed = false
        // Retry a failed redirect at the cockpit, never a stale SSO callback.
        startLoading()
        web.load(URLRequest(url: URL(string: connection.endpoint)!, timeoutInterval: 20))
    }
    @objc private func resume() {
        if failed { reload() }
        // WebKit forwards visibility changes; the cockpit reconciles its SSE stream on resume.
    }
    private func show(_ message: String) { status.text = "  \(message)  "; status.isHidden = false }
    private func startLoading() {
        show("Connecting…")
        loadWatchdog?.invalidate()
        loadWatchdog = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
            guard let self, self.web != nil else { return }
            self.web.stopLoading()
            self.failed = true
            self.show("Connection timed out. Check your network or VPN, then tap Refresh.")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if connection.allows(url) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        loadWatchdog?.invalidate()
        if action.navigationType == .linkActivated, Connection.origin(url) != nil {
            external(url)
        } else {
            show("Blocked navigation to \(Connection.origin(url) ?? "an unsupported address"). Check the trusted sign-in origin in Servers.")
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if connection.allows(url) { webView.load(action.request) }
        else if Connection.origin(url) != nil { external(url) }
        return nil
    }

    private func external(_ url: URL) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Open in browser?", message: Connection.origin(url), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open", style: .default) { _ in UIApplication.shared.open(url) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { startLoading() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadWatchdog?.invalidate()
        failed = false
        status.isHidden = true
        title = webView.url?.host
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error) }
    private func report(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        loadWatchdog?.invalidate()
        failed = true
        show("Could not connect. Check your network or VPN, then tap Refresh.")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { loadWatchdog?.invalidate(); failed = true; show("The page was suspended. Tap Refresh to reconnect.") }
}
