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
        XCTAssertTrue(app.buttons["browserControls"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.navigationBars.count, 0)
        let error = NSPredicate(format: "label CONTAINS 'Refresh'")
        expectation(for: error, evaluatedWith: app.staticTexts["connectionStatus"])
        waitForExpectations(timeout: 35)
        app.buttons["browserControls"].tap()
        XCTAssertFalse(app.buttons["Back"].isEnabled)
        app.buttons["Connection settings"].tap()
        XCTAssertTrue(app.buttons["connect"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Cezarion"].exists)
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
        expectation(for: NSPredicate(format: "value == %@", auth), evaluatedWith: app.buttons["browserControls"])
        waitForExpectations(timeout: 30)
        app.buttons["browserControls"].tap()
        XCTAssertTrue(app.staticTexts[auth].waitForExistence(timeout: 5))
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap() }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Remote sign-in"; screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func fixture() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--endpoint", "https://127.0.0.1:65534", "--auth-origin", "", "--browser-fixture"]
        app.launch()
        app.buttons["connect"].tap()
        XCTAssertTrue(app.webViews.staticTexts["First page"].waitForExistence(timeout: 10))
        return app
    }

    func testEdgeSwipeGoesBackInWebHistory() {
        let app = fixture()
        app.webViews.buttons["Next page"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 5))
        app.buttons["browserControls"].tap()
        XCTAssertTrue(app.buttons["Back"].isEnabled)
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap() }
        let web = app.webViews.firstMatch
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.35)))
        XCTAssertTrue(app.webViews.staticTexts["First page"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["browserControls"].exists)
        XCTAssertFalse(app.buttons["connect"].exists)
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.35)))
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 10))
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.35)))
        XCTAssertTrue(app.webViews.staticTexts["First page"].waitForExistence(timeout: 10))
        app.webViews.buttons["Next route"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Second route"].waitForExistence(timeout: 5))
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.35))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.35)))
        XCTAssertTrue(app.webViews.staticTexts["First page"].waitForExistence(timeout: 10))
    }

    func testNestedScrollingDoesNotRefreshButTopEdgePullDoes() {
        let app = fixture()
        app.webViews.buttons["Next page"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 5))
        app.webViews.buttons["Edit draft"].tap()
        let web = app.webViews.firstMatch
        web.swipeUp()
        web.swipeDown()
        // A reload would lose this in-document state. Body scrolling must preserve it.
        XCTAssertTrue(app.webViews.staticTexts["Unsaved draft"].exists)
        let controls = app.buttons["browserControls"]
        let originalY = controls.frame.midY
        controls.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.75)))
        XCTAssertGreaterThan(controls.frame.midY, originalY + 40)
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02))
            .press(forDuration: 0.05, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
        XCTAssertTrue(app.webViews.staticTexts["Second page"].waitForExistence(timeout: 10))
        controls.tap()
        app.buttons["Connection settings"].tap()
        XCTAssertTrue(app.buttons["connect"].waitForExistence(timeout: 5))
    }
}
