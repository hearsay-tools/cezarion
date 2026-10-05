import XCTest

final class LauncherTests: XCTestCase {
    func testRejectsHTTPAndCanForgetConnection() {
        let app = XCUIApplication()
        app.launchArguments = ["--endpoint", "http://example.com", "--auth-origin", ""]
        app.launch()
        app.buttons["connect"].tap()
        XCTAssertTrue(app.staticTexts["message"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["message"].label.contains("HTTPS"))
        app.buttons["Forget connection & sign out"].tap()
        app.alerts.buttons["Forget"].tap()
        let cleared = NSPredicate(format: "value == %@", "https://cezar.example.com")
        expectation(for: cleared, evaluatedWith: app.textFields["endpoint"])
        waitForExpectations(timeout: 10)
    }

    func testHTTPSConnectionReachesWebView() {
        let app = XCUIApplication()
        // A local closed HTTPS port gives a deterministic recoverable network failure.
        app.launchArguments = ["--endpoint", "https://127.0.0.1:65534", "--auth-origin", ""]
        app.launch()
        app.buttons["connect"].tap()
        XCTAssertTrue(app.buttons["Connection"].waitForExistence(timeout: 10))
        let error = NSPredicate(format: "label CONTAINS 'Refresh'")
        expectation(for: error, evaluatedWith: app.staticTexts["connectionStatus"])
        waitForExpectations(timeout: 35)
        app.buttons["Connection"].tap()
        XCTAssertTrue(app.buttons["connect"].waitForExistence(timeout: 5))
    }

    func testOptionalRemoteSignIn() throws {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["MOBILE_TEST_ENDPOINT"], endpoint.hasPrefix("https://"),
              let auth = env["MOBILE_TEST_AUTH_ORIGIN"], auth.hasPrefix("https://") else {
            throw XCTSkip("Set MOBILE_TEST_ENDPOINT and MOBILE_TEST_AUTH_ORIGIN to exercise a real sign-in service.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--endpoint", endpoint, "--auth-origin", auth]
        app.launch()
        app.buttons["connect"].tap()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(app.navigationBars[URL(string: auth)!.host!].waitForExistence(timeout: 30))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Remote sign-in"; screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
