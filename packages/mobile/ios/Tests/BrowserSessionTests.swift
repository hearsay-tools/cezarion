import XCTest
import WebKit
@testable import Cezarion

final class BrowserSessionTests: XCTestCase {
    @MainActor func testClearingSessionRemovesPersistentCookies() async throws {
        let cookies = WKWebsiteDataStore.default().httpCookieStore
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "cezarion.example.test", .path: "/", .name: "session-test",
            .value: "disposable", .secure: "TRUE", .expires: Date().addingTimeInterval(3600)
        ]))
        await cookies.setCookie(cookie)
        let before = await cookies.allCookies()
        XCTAssertTrue(before.contains { $0.name == "session-test" })
        await withCheckedContinuation { continuation in BrowserSession.clear { continuation.resume() } }
        let after = await cookies.allCookies()
        XCTAssertFalse(after.contains { $0.name == "session-test" })
    }
}
