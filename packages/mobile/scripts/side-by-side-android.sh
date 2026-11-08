#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
cd "$repo_root/packages/mobile/android"

# The legacy matrix entry already built and tested these APKs on this emulator.
app_output=app/build/outputs/apk/debug/app-debug.apk
test_output=app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
saved=../build/android-side-by-side
reports=app/build/reports/side-by-side
mkdir -p "$saved/legacy" "$saved/rebrand" "$reports"
cp "$app_output" "$saved/legacy/app.apk"
cp "$test_output" "$saved/legacy/test.apk"
# Keep the ordinary legacy job's downloadable APK and test APK unchanged.
trap 'cp "$saved/legacy/app.apk" "$app_output"; cp "$saved/legacy/test.apk" "$test_output"' EXIT
./gradlew --no-daemon -Prebrand=on assembleDebug assembleDebugAndroidTest
cp "$app_output" "$saved/rebrand/app.apk"
cp "$test_output" "$saved/rebrand/test.apk"

legacy_id=$(node ../../cezar/scripts/product-identity.mjs --rebrand off | jq -r .mobileAppId).debug
rebrand_id=$(node ../../cezar/scripts/product-identity.mjs --rebrand on | jq -r .mobileAppId).debug
test "$legacy_id" != "$rebrand_id"
for app_id in "$legacy_id" "$rebrand_id"; do
    adb uninstall "$app_id" >/dev/null 2>&1 || true
    adb uninstall "$app_id.test" >/dev/null 2>&1 || true
done
for mode in legacy rebrand; do
    adb install "$saved/$mode/app.apk"
    adb install "$saved/$mode/test.apk"
done

check() {
    local app_id=$1 method=$2
    adb shell am instrument -w -r -e sideBySide true -e expectedAppId "$app_id" \
        -e class "tools.hearsay.cezarion.SideBySideTest#$method" \
        "$app_id.test/androidx.test.runner.AndroidJUnitRunner" | tee "$reports/$method.txt"
    # am instrument can exit zero even when the test fails. Require an executed pass.
    grep -Eq '^INSTRUMENTATION_STATUS_CODE: 0[[:space:]]*$' "$reports/$method.txt"
    grep -Eq '^OK \(1 test\)[[:space:]]*$' "$reports/$method.txt"
}
check "$legacy_id" seedLegacySession
check "$rebrand_id" newAppNeedsConnectionAndSignIn
check "$legacy_id" legacySessionRemainsUnchanged
