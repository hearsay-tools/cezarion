import Foundation

/// The phone owns one browser session. Changing either trust boundary clears it.
struct Connection: Codable, Equatable {
    let endpoint: String
    let signInOrigin: String

    init(endpoint: String, signInOrigin: String) throws {
        let server = try Self.parse(endpoint)
        self.endpoint = server.absoluteString
        if signInOrigin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.signInOrigin = ""
        } else {
            let auth = try Self.parse(signInOrigin)
            guard auth.path.isEmpty || auth.path == "/" else { throw ConnectionError.origin }
            self.signInOrigin = Self.origin(auth)!
        }
    }

    static func parse(_ raw: String) throws -> URL {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.contains("\\"), !value.contains(where: { $0.isWhitespace }),
              let parts = URLComponents(string: value), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, !host.contains("%"),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { throw ConnectionError.address }
        return url
    }

    static func origin(_ url: URL) -> String? {
        guard let p = URLComponents(url: url, resolvingAgainstBaseURL: false),
              p.scheme?.lowercased() == "https", let host = p.host, !host.isEmpty,
              p.user == nil, p.password == nil, !host.contains("%"),
              p.port == nil || (1...65535).contains(p.port!) else { return nil }
        return "https://\(host.lowercased())" + (p.port == nil || p.port == 443 ? "" : ":\(p.port!)")
    }

    func allows(_ url: URL) -> Bool {
        guard !url.absoluteString.contains("\\"), let origin = Self.origin(url) else { return false }
        return origin == Self.origin(URL(string: endpoint)!) || (!signInOrigin.isEmpty && origin == signInOrigin)
    }
}

enum ConnectionError: LocalizedError {
    case address, origin
    var errorDescription: String? {
        switch self {
        case .address: return "Enter an HTTPS address without passwords, query parameters, or fragments."
        case .origin: return "The sign-in origin must have no path, for example https://auth.example.com."
        }
    }
}
