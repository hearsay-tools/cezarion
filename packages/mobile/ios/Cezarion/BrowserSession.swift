import WebKit

enum BrowserSession {
    static func clear(completion: @escaping () -> Void) {
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast, completionHandler: completion)
    }
}
