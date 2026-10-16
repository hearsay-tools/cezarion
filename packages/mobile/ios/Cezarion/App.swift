import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Main", sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UINavigationController(rootViewController: ConnectionController())
        window.tintColor = UIColor(red: 1, green: 0.73, blue: 0.22, alpha: 1)
        window.overrideUserInterfaceStyle = .dark
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class ConnectionController: UIViewController {
    private let endpoint = UITextField()
    private let auth = UITextField()
    private let message = UILabel()
    private let connect = UIButton(type: .system)
    private let forget = UIButton(type: .system)
    private let defaults = UserDefaults.standard
    private let key = "connection"

    private var saved: Connection? {
        guard let data = defaults.data(forKey: key), let decoded = try? JSONDecoder().decode(Connection.self, from: data) else { return nil }
        return try? Connection(endpoint: decoded.endpoint, signInOrigin: decoded.signInOrigin)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cezarion"
        view.backgroundColor = UIColor(red: 0.043, green: 0.063, blue: 0.11, alpha: 1)
        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .interactive
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 36),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -28),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24)
        ])
        let mark = UIImageView(image: UIImage(named: "Mark"))
        mark.contentMode = .scaleAspectFit
        mark.heightAnchor.constraint(equalToConstant: 76).isActive = true
        stack.addArrangedSubview(mark)
        stack.addArrangedSubview(label("Your agents. In your pocket.", size: 27, weight: .bold))
        stack.addArrangedSubview(label("Connect to your Cezarion server to follow tasks and keep work moving.", size: 16))
        stack.addArrangedSubview(label("Cockpit address", size: 14, weight: .semibold))
        configure(endpoint, placeholder: "https://cezar.example.com", id: "endpoint")
        stack.addArrangedSubview(endpoint)
        stack.addArrangedSubview(label("Trusted sign-in origin · optional", size: 14, weight: .semibold))
        configure(auth, placeholder: "https://auth.example.com", id: "authOrigin")
        stack.addArrangedSubview(auth)
        stack.addArrangedSubview(label("If your server redirects to a separate sign-in service, enter its HTTPS origin here.", size: 13))
        var config = UIButton.Configuration.filled()
        config.title = "Connect"
        config.baseBackgroundColor = UIColor(red: 1, green: 0.73, blue: 0.22, alpha: 1)
        config.baseForegroundColor = .black
        config.cornerStyle = .medium
        connect.configuration = config
        connect.accessibilityIdentifier = "connect"
        connect.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        connect.addTarget(self, action: #selector(openConnection), for: .touchUpInside)
        stack.addArrangedSubview(connect)
        message.numberOfLines = 0
        message.textColor = .systemOrange
        message.accessibilityIdentifier = "message"
        stack.addArrangedSubview(message)
        stack.addArrangedSubview(label("Your address and website sign-in are remembered on this device. Agents keep running on your server when you close the app.", size: 13))
        forget.setTitle("Forget connection & sign out", for: .normal)
        forget.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        forget.addTarget(self, action: #selector(confirmForget), for: .touchUpInside)
        stack.addArrangedSubview(forget)
        endpoint.text = saved?.endpoint
        auth.text = saved?.signInOrigin
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--endpoint"), args.indices.contains(i + 1) { endpoint.text = args[i + 1] }
        if let i = args.firstIndex(of: "--auth-origin"), args.indices.contains(i + 1) { auth.text = args[i + 1] }
        #endif
    }

    private func configure(_ field: UITextField, placeholder: String, id: String) {
        field.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(white: 0.62, alpha: 1)])
        field.backgroundColor = UIColor(red: 0.075, green: 0.10, blue: 0.16, alpha: 1)
        field.textColor = .white
        field.accessibilityLabel = id == "endpoint" ? "Cockpit address" : "Trusted sign-in origin"
        field.accessibilityIdentifier = id
        field.borderStyle = .roundedRect
        field.keyboardType = .URL
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.clearButtonMode = .whileEditing
        field.font = .preferredFont(forTextStyle: .body)
        field.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    }

    private func label(_ text: String, size: CGFloat, weight: UIFont.Weight = .regular) -> UILabel {
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: size, weight: weight))
        label.adjustsFontForContentSizeCategory = true
        label.textColor = weight == .bold ? .white : .secondaryLabel
        return label
    }

    @objc private func openConnection() {
        view.endEditing(true)
        do {
            let connection = try Connection(endpoint: endpoint.text ?? "", signInOrigin: auth.text ?? "")
            message.text = nil
            let open = { [self] in
                defaults.set(try? JSONEncoder().encode(connection), forKey: key)
                setBusy(false)
                navigationController?.pushViewController(CockpitController(connection: connection), animated: true)
            }
            if saved != connection {
                setBusy(true)
                BrowserSession.clear(completion: open)
            } else { open() }
        } catch { message.text = error.localizedDescription }
    }

    @objc private func confirmForget() {
        let alert = UIAlertController(title: "Forget this connection?", message: "This clears the saved address, cookies, and website data from this app.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Forget", style: .destructive) { [self] _ in
            setBusy(true)
            BrowserSession.clear { [self] in
                defaults.removeObject(forKey: key)
                endpoint.text = ""; auth.text = ""; message.text = "Connection and sign-in cleared."
                setBusy(false)
            }
        })
        present(alert, animated: true)
    }

    private func setBusy(_ value: Bool) { connect.isEnabled = !value; forget.isEnabled = !value }
}
