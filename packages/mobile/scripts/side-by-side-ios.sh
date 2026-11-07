#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
cd "$repo_root"
: "${SIMULATOR_ID:?Run after the legacy matrix job boots its simulator}"

legacy_id=$(node packages/cezar/scripts/product-identity.mjs --rebrand off | jq -r .mobileAppId)
rebrand_id=$(node packages/cezar/scripts/product-identity.mjs --rebrand on | jq -r .mobileAppId)
test "$legacy_id" != "$rebrand_id"
saved=packages/mobile/build/ios-side-by-side
legacy_products=packages/mobile/build/ios/Build/Products
rebrand_products=$saved/Build/Products
reports=packages/mobile/build/ios/Logs/Test
mkdir -p "$saved" "$reports"
cp packages/mobile/ios/ProductIdentity.xcconfig "$saved/legacy.xcconfig"
trap 'cp "$saved/legacy.xcconfig" packages/mobile/ios/ProductIdentity.xcconfig' EXIT

# Reuse the legacy app and test binaries from the preceding per-mode CI run.
xcodebuild -project packages/mobile/ios/Cezarion.xcodeproj -scheme Cezarion \
    -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
    -derivedDataPath packages/mobile/build/ios CODE_SIGNING_ALLOWED=NO build-for-testing
node packages/mobile/scripts/build-metadata.mjs --rebrand on --write-ios
xcodebuild -project packages/mobile/ios/Cezarion.xcodeproj -scheme Cezarion \
    -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
    -derivedDataPath "$saved" CODE_SIGNING_ALLOWED=NO build-for-testing

for app_id in "$legacy_id" "$rebrand_id"; do
    xcrun simctl terminate "$SIMULATOR_ID" "$app_id" >/dev/null 2>&1 || true
    xcrun simctl uninstall "$SIMULATOR_ID" "$app_id" >/dev/null 2>&1 || true
done
xcrun simctl install "$SIMULATOR_ID" "$legacy_products/Debug-iphonesimulator/Cezarion.app"
xcrun simctl install "$SIMULATOR_ID" "$rebrand_products/Debug-iphonesimulator/Cezarion.app"

check() {
    local products=$1 app_id=$2 method=$3 run_file
    # xctestrun retains each compiled host's path and bundle ID. Add test-only inputs
    # to that host's environment, without changing the app or the shared scheme.
    run_file=$(python3 - "$products" "$app_id" <<'PY'
import pathlib
import plistlib
import sys

products = pathlib.Path(sys.argv[1])
sources = [p for p in products.glob('*.xctestrun') if p.name != 'side-by-side.xctestrun']
if len(sources) != 1:
    raise SystemExit(f'Expected one xctestrun in {products}, got {sources}')
with sources[0].open('rb') as source:
    run = plistlib.load(source)
targets = [target for config in run['TestConfigurations'] for target in config['TestTargets']]
for target in targets:
    env = target.setdefault('EnvironmentVariables', {})
    env['MOBILE_SIDE_BY_SIDE'] = '1'
    env['MOBILE_SIDE_BY_SIDE_APP_ID'] = sys.argv[2]
destination = products / 'side-by-side.xctestrun'
with destination.open('wb') as output:
    plistlib.dump(run, output)
print(destination)
PY
)
    xcodebuild -xctestrun "$run_file" -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
        -parallel-testing-enabled NO -only-testing:"CezarionTests/SideBySideIsolationTests/$method" \
        -resultBundlePath "$reports/side-by-side-$method.xcresult" test-without-building \
        2>&1 | tee "$saved/$method.log"
    # A skipped test cannot prove isolation. Require the selected test to execute.
    grep -E "[Tt]est [Cc]ase.*$method.*passed" "$saved/$method.log"
}
check "$legacy_products" "$legacy_id" testSeedLegacySession
check "$rebrand_products" "$rebrand_id" testNewAppNeedsConnectionAndSignIn
check "$legacy_products" "$legacy_id" testLegacySessionRemainsUnchanged
