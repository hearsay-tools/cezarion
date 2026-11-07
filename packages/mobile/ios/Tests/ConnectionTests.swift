import XCTest
import UIKit
@testable import Cezarion

final class ConnectionTests: XCTestCase {
    func testRejectsUnsafeSavedAddresses() {
        for value in ["", "http://localhost", "http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com?token=secret", "https://example.com#token", "https://example.com:0", "https://example.com:65536", "https://example.com\\@evil.test", "https://exa mple.com"] {
            XCTAssertThrowsError(try Connection(endpoint: value, signInOrigin: ""), value)
        }
    }
    func testExactOriginTrustIncludingPortsAndCredentialRejection() throws {
        let c = try Connection(endpoint: "https://cockpit.example.com/", signInOrigin: "https://auth.example.com")
        for value in ["https://cockpit.example.com/api/v1", "https://auth.example.com/?rd=callback", "https://COCKPIT.example.com:443/p/project"] {
            XCTAssertTrue(c.allows(URL(string: value)!), value)
        }
        for value in ["http://cockpit.example.com", "https://cockpit.example.com.evil.test/", "https://auth.example.com:8443/", "https://other.example.com", "https://user@cockpit.example.com", "file:///etc/passwd", "javascript:alert(1)"] {
            XCTAssertFalse(c.allows(URL(string: value)!), value)
        }
    }
    func testAuthOriginAndChangedTrust() throws {
        XCTAssertThrowsError(try Connection(endpoint: "https://example.com", signInOrigin: "https://auth.example.com/login"))
        let c = try Connection(endpoint: " https://example.com ", signInOrigin: "https://auth.example.com:443/")
        XCTAssertEqual(c.signInOrigin, "https://auth.example.com")
        XCTAssertNotEqual(c, try Connection(endpoint: "https://example.com", signInOrigin: ""))
        XCTAssertFalse(try Connection(endpoint: "https://example.com", signInOrigin: "").allows(URL(string: "https://auth.example.com")!))
    }
}

final class MoveControllerTests: XCTestCase {
    @MainActor func testButtonOpensSuppliedStorePageWithoutChangingSavedConnection() throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "connection")
        defer { defaults.set(previous, forKey: "connection") }
        defaults.set(Data("old connection".utf8), forKey: "connection")
        let url = try XCTUnwrap(URL(string: "https://apps.apple.com/app/example?id=123&campaign=test"))
        var opened: URL?
        let controller = MoveController(storeURL: url, openStore: { opened = $0 })
        controller.loadViewIfNeeded()
        controller.storeButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(opened, url)
        XCTAssertEqual(defaults.data(forKey: "connection"), Data("old connection".utf8))
    }
    #if FINAL_OLD_APP
    @MainActor func testFinalBuildButtonUsesReleaseInput() throws {
        let expected = try XCTUnwrap(MobileBuild.storeURL)
        var opened: URL?
        let controller = MoveController(openStore: { opened = $0 })
        controller.loadViewIfNeeded()
        controller.storeButton.sendActions(for: .touchUpInside)
        XCTAssertEqual(opened, expected)
    }
    #endif
}
