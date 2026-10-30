import UIKit
import WebKit

final class CockpitController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
    private let connection: Connection
    private var web: WKWebView!
    private let status = UILabel()
    private let controls = UIButton(type: .system)
    private let pullHint = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var controlsPosition: NSLayoutConstraint!
    private var dragOrigin: CGFloat = 0
    private var loadWatchdog: Timer?
    private var failed = false
    #if DEBUG
    private var usesFixture: Bool { ProcessInfo.processInfo.arguments.contains("--browser-fixture") }
    #endif
    init(connection: Connection) { self.connection = connection; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        // The left-edge swipe belongs to WebKit history, not the connection form.
        navigationController?.interactivePopGestureRecognizer?.isEnabled = false
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if isMovingFromParent {
            navigationController?.setNavigationBarHidden(false, animated: false)
            navigationController?.interactivePopGestureRecognizer?.isEnabled = true
            dispose()
        }
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        #if DEBUG
        if usesFixture { configuration.setURLSchemeHandler(FixturePages(), forURLScheme: "cezar-fixture") }
        #endif
        // No script message handlers or native bridge are granted to remote content.
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        // The cockpit's overscroll-contain suppresses WebKit's browser gestures.
        // Native edge recognizers below own history without changing the page's CSS.
        web.allowsBackForwardNavigationGestures = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.translatesAutoresizingMaskIntoConstraints = false
        web.accessibilityIdentifier = "cockpit"
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
        installControls()
        NotificationCenter.default.addObserver(self, selector: #selector(resume), name: UIApplication.didBecomeActiveNotification, object: nil)
        reconnect()
    }

    private func installControls() {
        var config = UIButton.Configuration.filled()
        config.image = UIImage(systemName: "ellipsis")
        config.baseForegroundColor = .white
        config.baseBackgroundColor = UIColor(white: 0.15, alpha: 0.85)
        config.cornerStyle = .capsule
        controls.configuration = config
        controls.accessibilityLabel = "Browser controls"
        controls.accessibilityHint = "Back, refresh and connection settings. Drag to move."
        controls.accessibilityIdentifier = "browserControls"
        controls.accessibilityValue = Connection.origin(URL(string: connection.endpoint)!)
        controls.addTarget(self, action: #selector(showControls), for: .touchUpInside)
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        controlsPosition = controls.centerYAnchor.constraint(equalTo: web.centerYAnchor)
        NSLayoutConstraint.activate([
            controls.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -6),
            controls.widthAnchor.constraint(equalToConstant: 44), controls.heightAnchor.constraint(equalToConstant: 44),
            controlsPosition
        ])
        controls.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(moveControls(_:))))
        pullHint.text = "Pull to refresh"
        pullHint.font = .preferredFont(forTextStyle: .footnote)
        pullHint.textColor = .white
        pullHint.backgroundColor = UIColor(white: 0.15, alpha: 0.95)
        pullHint.layer.cornerRadius = 12; pullHint.clipsToBounds = true
        pullHint.isHidden = true
        pullHint.accessibilityIdentifier = "pullHint"
        for overlay in [pullHint, spinner] {
            overlay.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(overlay)
            NSLayoutConstraint.activate([
                overlay.centerXAnchor.constraint(equalTo: web.centerXAnchor),
                overlay.topAnchor.constraint(equalTo: web.topAnchor, constant: 12)
            ])
        }
        spinner.hidesWhenStopped = true
        spinner.accessibilityIdentifier = "loading"
        // The cockpit intentionally contains overscroll in nested panels. Observe only
        // a vertical pull starting in its top 48pt; never steal conversation scrolling.
        let pull = UIPanGestureRecognizer(target: self, action: #selector(pullToRefresh(_:)))
        pull.maximumNumberOfTouches = 1
        pull.cancelsTouchesInView = false
        pull.delegate = self
        web.addGestureRecognizer(pull)
        for edge: UIRectEdge in [.left, .right] {
            let history = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(swipeHistory(_:)))
            history.edges = edge
            history.delegate = self
            web.addGestureRecognizer(history)
            web.scrollView.panGestureRecognizer.require(toFail: history)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard web != nil, controlsPosition != nil else { return }
        controlsPosition.constant = clampedControlOffset(controlsPosition.constant)
    }
    private func clampedControlOffset(_ value: CGFloat) -> CGFloat {
        let limit = max(0, web.bounds.height / 2 - 28)
        return min(limit, max(-limit, value))
    }
    @objc private func moveControls(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { dragOrigin = controlsPosition.constant }
        controlsPosition.constant = clampedControlOffset(dragOrigin + gesture.translation(in: view).y)
    }
    @objc private func showControls() {
        guard presentedViewController == nil else { return }
        view.endEditing(true)
        let sheet = UIAlertController(title: "Cezarion", message: Connection.origin(web.url ?? URL(string: connection.endpoint)!), preferredStyle: .actionSheet)
        let back = UIAlertAction(title: "Back", style: .default) { [weak self] _ in self?.web?.goBack() }
        back.isEnabled = web.canGoBack
        sheet.addAction(back)
        let forward = UIAlertAction(title: "Forward", style: .default) { [weak self] _ in self?.web?.goForward() }
        forward.isEnabled = web.canGoForward
        sheet.addAction(forward)
        sheet.addAction(UIAlertAction(title: "Refresh", style: .default) { [weak self] _ in self?.refresh() })
        sheet.addAction(UIAlertAction(title: "Connection settings", style: .default) { [weak self] _ in self?.close() })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.popoverPresentationController?.sourceView = controls
        sheet.popoverPresentationController?.sourceRect = controls.bounds
        present(sheet, animated: true)
    }
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer else { return false }
        if let edge = pan as? UIScreenEdgePanGestureRecognizer {
            let velocity = pan.velocity(in: web)
            let backward = edge.edges == .left
            return (backward ? web.canGoBack : web.canGoForward)
                && (backward ? velocity.x : -velocity.x) > abs(velocity.y) * 2
        }
        let start = pan.location(in: web) - pan.translation(in: web)
        let velocity = pan.velocity(in: web)
        return start.y >= 0 && start.y <= 48 && start.x > 28 && start.x < web.bounds.width - 28
            && velocity.y > abs(velocity.x) * 2 && web.scrollView.contentOffset.y <= 1
    }
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        !(gesture is UIScreenEdgePanGestureRecognizer) && !(other is UIScreenEdgePanGestureRecognizer)
    }
    @objc private func swipeHistory(_ gesture: UIScreenEdgePanGestureRecognizer) {
        let backward = gesture.edges == .left
        let delta = gesture.translation(in: web)
        let distance = backward ? delta.x : -delta.x
        let speed = backward ? gesture.velocity(in: web).x : -gesture.velocity(in: web).x
        let ready = (distance > max(60, web.bounds.width * 0.18) || (distance > 20 && speed > 650)) && distance > abs(delta.y) * 2
        if gesture.state == .changed {
            pullHint.text = backward ? "  ← Back  " : "  Forward →  "
            pullHint.isHidden = distance < 20
        } else if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
            pullHint.isHidden = true
            if gesture.state == .ended && ready {
                if backward { web.goBack() } else { web.goForward() }
            }
        }
    }
    @objc private func pullToRefresh(_ gesture: UIPanGestureRecognizer) {
        let delta = gesture.translation(in: web)
        let ready = delta.y >= 100 && delta.y > abs(delta.x) * 2
        if gesture.state == .changed {
            pullHint.text = ready ? "  Release to refresh  " : "  Pull to refresh  "
            pullHint.isHidden = delta.y < 20 || spinner.isAnimating
        } else if gesture.state == .ended || gesture.state == .cancelled || gesture.state == .failed {
            pullHint.isHidden = true
            if gesture.state == .ended && ready { refresh() }
        }
    }

    deinit { loadWatchdog?.invalidate(); NotificationCenter.default.removeObserver(self) }
    private func dispose() {
        loadWatchdog?.invalidate()
        NotificationCenter.default.removeObserver(self)
        web?.stopLoading()
        web?.navigationDelegate = nil; web?.uiDelegate = nil
    }
    @objc private func close() { navigationController?.popViewController(animated: true) }
    private func reconnect() {
        failed = false
        startLoading()
        #if DEBUG
        if usesFixture { web.load(URLRequest(url: URL(string: "cezar-fixture://cockpit/first")!)); return }
        #endif
        web.load(URLRequest(url: URL(string: connection.endpoint)!, timeoutInterval: 20))
    }
    private func isCockpitPage(_ url: URL) -> Bool {
        #if DEBUG
        if usesFixture && url.scheme == "cezar-fixture" && url.host == "cockpit" { return true }
        #endif
        return connection.allows(url) && Connection.origin(url) == Connection.origin(URL(string: connection.endpoint)!)
    }
    private func refresh() {
        // Keep the current cockpit route. Recover errors and SSO callbacks at the
        // starting address instead of replaying a failed/authentication request.
        if !failed, let url = web.url, isCockpitPage(url) {
            startLoading(); web.reload()
        } else { reconnect() }
    }
    @objc private func resume() { if failed { reconnect() } }
    private func show(_ message: String) { status.text = "  \(message)  "; status.isHidden = false }
    private func finishLoading() { loadWatchdog?.invalidate(); spinner.stopAnimating(); pullHint.isHidden = true }
    private func startLoading() {
        status.isHidden = true
        spinner.startAnimating()
        loadWatchdog?.invalidate()
        loadWatchdog = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.web.stopLoading(); self.finishLoading(); self.failed = true
            self.show("Connection timed out. Check your network or VPN, then choose Refresh in ⋯.")
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if connection.allows(url) || isCockpitPage(url) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        finishLoading()
        if action.navigationType == .linkActivated, Connection.origin(url) != nil { external(url) }
        else {
            failed = true
            show("Blocked navigation to \(Connection.origin(url) ?? "an unsupported address"). Check ⋯ → Connection settings.")
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
        finishLoading(); failed = false
        controls.accessibilityValue = webView.url.flatMap(Connection.origin)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { report(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { report(error) }
    private func report(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        finishLoading(); failed = true
        show("Could not connect. Check your network or VPN, then choose Refresh in ⋯.")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finishLoading(); failed = true; show("The page was suspended. Choose Refresh in ⋯ to reconnect.") }
}

private extension CGPoint {
    static func - (lhs: CGPoint, rhs: CGPoint) -> CGPoint { CGPoint(x: lhs.x - rhs.x, y: lhs.y - rhs.y) }
}

#if DEBUG
private final class FixturePages: NSObject, WKURLSchemeHandler {
    // Offline UI test pages, excluded from Release. Scheme responses create real
    // navigation entries; loadHTMLString's synthetic document has no back entry.
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let url = task.request.url!
        let page = url.path == "/second" ? "Second page" : "First page"
        let html = """
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{margin:0;background:#0b101c;color:white;font:18px system-ui;height:100dvh;overflow:hidden}header{height:48px}main{height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain}p{height:80px}button{font:inherit;margin:8px}</style>
        <header>Gesture test</header><main><button onclick="location.href='cezar-fixture://cockpit/second'">Next page</button><button onclick="history.pushState({},'', '#route');document.getElementById('page').textContent='Second route'">Next route</button><button onclick="document.getElementById('page').textContent='Unsaved draft'">Edit draft</button><div id="page">\(page)</div><div id="rows"></div></main>
        <script>for(let i=0;i<25;i++)document.getElementById('rows').innerHTML+='<p>Conversation row '+i+'</p>';onpopstate=()=>document.getElementById('page').textContent='First page';</script>
        """
        let data = Data(html.utf8)
        task.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        task.didReceive(data); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
#endif
