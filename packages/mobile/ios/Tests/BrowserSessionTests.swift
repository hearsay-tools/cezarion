import XCTest
import WebKit
import UIKit
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

/// The legacy CI job runs these stages against two installed bundle IDs on one simulator.
final class SideBySideIsolationTests: XCTestCase {
    private let cookieName = "mobile_isolation"

    private func requireSideBySideRun() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["MOBILE_SIDE_BY_SIDE"] == "1" else {
            throw XCTSkip("Run through scripts/side-by-side-ios.sh")
        }
        XCTAssertEqual(Bundle.main.bundleIdentifier, env["MOBILE_SIDE_BY_SIDE_APP_ID"])
        XCTAssertFalse(MobileBuild.finalOldApp)
    }

    private func connectionData() throws -> Data {
        let connection = try Connection(endpoint: "https://isolation.example.test", signInOrigin: "https://login.isolation.example.test")
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try encoder.encode(connection)
    }

    @MainActor func testSeedLegacySession() async throws {
        try requireSideBySideRun()
        UserDefaults.standard.set(try connectionData(), forKey: "connection")
        XCTAssertTrue(UserDefaults.standard.synchronize())
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "isolation.example.test", .path: "/", .name: cookieName,
            .value: "legacy-session", .secure: "TRUE", .expires: Date().addingTimeInterval(86400)
        ]))
        let store = WKWebsiteDataStore.default().httpCookieStore
        await store.setCookie(cookie)
        // setCookie completes when WebKit accepts the cookie, before its disk write.
        // This SPI exists only in the test bundle; no private API ships in the app.
        let flush = NSSelectorFromString("_flushCookiesToDiskWithCompletionHandler:")
        guard store.responds(to: flush) else {
            XCTFail("The simulator WebKit must provide a cookie persistence callback")
            return
        }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let completion: @convention(block) () -> Void = { continuation.resume() }
            _ = store.perform(flush, with: completion)
        }
        let cookies = await store.allCookies()
        XCTAssertTrue(cookies.contains { $0.name == cookieName && $0.value == "legacy-session" })
        try assertConnectionFields(endpoint: "https://isolation.example.test", auth: "https://login.isolation.example.test")
    }

    @MainActor func testNewAppNeedsConnectionAndSignIn() async throws {
        try requireSideBySideRun()
        // Inspect before any connection/reset action could hide an accidental import.
        XCTAssertNil(UserDefaults.standard.data(forKey: "connection"))
        try assertConnectionFields(endpoint: "", auth: "")
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        XCTAssertFalse(cookies.contains { $0.name == cookieName }, "The new WebView must not inherit the old sign-in")
    }

    @MainActor func testLegacySessionRemainsUnchanged() async throws {
        try requireSideBySideRun()
        XCTAssertEqual(UserDefaults.standard.data(forKey: "connection"), try connectionData())
        try assertConnectionFields(endpoint: "https://isolation.example.test", auth: "https://login.isolation.example.test")
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        XCTAssertTrue(cookies.contains { $0.name == cookieName && $0.value == "legacy-session" })
    }

    @MainActor private func assertConnectionFields(endpoint: String, auth: String) throws {
        let controller = ConnectionController()
        controller.loadViewIfNeeded()
        let fields = descendants(controller.view).compactMap { $0 as? UITextField }
        let address = try XCTUnwrap(fields.first { $0.accessibilityIdentifier == "endpoint" })
        let origin = try XCTUnwrap(fields.first { $0.accessibilityIdentifier == "authOrigin" })
        XCTAssertEqual(address.text ?? "", endpoint)
        XCTAssertEqual(origin.text ?? "", auth)
    }

    @MainActor private func descendants(_ view: UIView) -> [UIView] {
        view.subviews.flatMap { [$0] + descendants($0) }
    }
}
