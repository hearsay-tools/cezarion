# Code quality check — 2026-10-23

Result: PASS. All 144 changed functions across 5 files have complexity <= 20 and CRAP <= 30. Equality passes.

Pinned merge-base: `9c8caa3586ec879632964aa05e945bcd5543e97b` (PR target: main).

The source hashes below identify the exact measured code. The change scanner includes committed, staged, unstaged and untracked work. Functions in test files stay in scope. The root metrics wrapper contains no implemented functions. Markdown, JSON and the dependency lockfile have no function scores.

CRAP uses executable function body line coverage, a line-coverage variant of the original basis-path metric. Every function matched current coverage. No inherited refactor was deferred, so this check required no code-quality-improvement issue.

The first scan found the newly added AST visitor at complexity 26. Splitting child enumeration from node analysis reduced it to 18 while preserving the existing parser behavior tests. The highest final complexity is 20; the highest final CRAP score is 20.0329.

## Measurement

The two node:test suites passed all 30 tests. A separate run collected V8 coverage because Squeal validation does not provide function coverage for this measurement. The installed @vitest/coverage-v8 dependencies @bcoe/v8-coverage and ast-v8-to-istanbul merged the raw process reports and converted them to Istanbul using the Babel ESTree parser. No coverage exclusions were added.

Run from the checkout root, using the already installed dependencies:

```sh
quality_dir=$(mktemp -d)
node .ai/skills/check-code-quality/scripts/changed-functions.mjs --base origin/main > "$quality_dir/scan.json"
NODE_V8_COVERAGE="$quality_dir/raw" node --import ./scripts/test-git-env.mjs --test scripts/metrics.test.mjs scripts/changed-functions.test.mjs
node --input-type=module - "$quality_dir" <<'JS'
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve('package.json'));
const provider = createRequire(require.resolve('@vitest/coverage-v8'));
const { mergeProcessCovs } = provider('@bcoe/v8-coverage');
const { default: convert } = await import(pathToFileURL(provider.resolve('ast-v8-to-istanbul')));
const { parse } = await import(pathToFileURL(require.resolve('@babel/parser')));
const directory = process.argv[2];
const scan = JSON.parse(readFileSync(join(directory, 'scan.json'), 'utf8'));
const selected = new Set(scan.files.map(file => pathToFileURL(resolve(file.file)).href));
const inputs = readdirSync(join(directory, 'raw')).filter(file => file.endsWith('.json')).map(file => {
  const raw = JSON.parse(readFileSync(join(directory, 'raw', file), 'utf8'));
  return { result: raw.result.filter(script => selected.has(script.url)) };
});
const report = {};
for (const coverage of mergeProcessCovs(inputs).result) {
  const code = readFileSync(new URL(coverage.url), 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['estree'], ranges: true }).program;
  Object.assign(report, await convert({ code, ast, coverage }));
}
writeFileSync(join(directory, 'coverage-final.json'), JSON.stringify(report));
JS
node .ai/skills/check-code-quality/scripts/metrics.mjs <changed-file> --coverage "$quality_dir/coverage-final.json" --json
```

The test command must succeed before converting coverage or accepting scores. Use
the pinned baseline SHA instead of `origin/main` to repeat the recorded scope after
the target branch advances. Select the scan's function names, lines and columns
from each file's metric results.

Squeal also reported both focused test files current and passing at revision 20. Full background validation and the 84 slow test files were still pending; this report does not claim they passed.

## Results

### .ai/skills/check-code-quality/scripts/changed-functions.mjs

SHA-256: `ea6a9daab76c85b4e5b498b848bda3cc06a9ab06f82be6fd0e5c3fa621a06364`.

| Function | Line:column | Complexity | Body line coverage | CRAP | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| exceededMetrics | 12:8 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@13:44 | 13:44 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@15:9 | 15:9 | 1 | 100.00% | 1.0000 | Pass |
| normalizeName | 18:23 | 1 | 100.00% | 1.0000 | Pass |
| identity | 19:1 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@20:27 | 20:27 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@21:21 | 21:21 | 1 | 100.00% | 1.0000 | Pass |
| ownSource | 26:1 | 3 | 100.00% | 3.0000 | Pass |
| anonymous@28:40 | 28:40 | 2 | 100.00% | 2.0000 | Pass |
| compareFunctions | 36:8 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@40:28 | 40:28 | 11 | 100.00% | 11.0000 | Pass |
| anonymous@42:44 | 42:44 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@44:37 | 44:37 | 1 | 100.00% | 1.0000 | Pass |
| scanChanges | 58:8 | 7 | 100.00% | 7.0000 | Pass |
| git | 59:15 | 1 | 100.00% | 1.0000 | Pass |
| pinnedGit | 66:21 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@70:12 | 70:12 | 1 | 100.00% | 1.0000 | Pass |
| runChangedFunctions | 87:8 | 10 | 80.00% | 10.8000 | Pass |

### .ai/skills/check-code-quality/scripts/code-metrics.mjs

SHA-256: `986a1209019baca426486cbc844639d40518d23f7c3ca7b4dab63d1852b067c3`.

| Function | Line:column | Complexity | Body line coverage | CRAP | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| childNodes | 14:1 | 8 | 100.00% | 8.0000 | Pass |
| functionName | 22:1 | 20 | 100.00% | 20.0000 | Pass |
| anonymous@28:40 | 28:40 | 2 | 100.00% | 2.0000 | Pass |
| analyzeSource | 39:8 | 3 | 100.00% | 3.0000 | Pass |
| visit | 47:3 | 18 | 100.00% | 18.0000 | Pass |
| anonymous@76:25 | 76:25 | 1 | 100.00% | 1.0000 | Pass |
| selectFunctions | 79:8 | 11 | 100.00% | 11.0000 | Pass |
| anonymous@82:32 | 82:32 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@85:32 | 85:32 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@86:13 | 86:13 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@92:92 | 92:92 | 1 | 100.00% | 1.0000 | Pass |
| unavailable | 97:21 | 1 | 100.00% | 1.0000 | Pass |
| isRecord | 98:18 | 3 | 100.00% | 3.0000 | Pass |
| measureCoverage | 101:8 | 13 | 100.00% | 13.0000 | Pass |
| anonymous@102:70 | 102:70 | 1 | 100.00% | 1.0000 | Pass |
| offset | 107:3 | 9 | 100.00% | 9.0000 | Pass |
| anonymous@115:38 | 115:38 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@116:41 | 116:41 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@121:34 | 121:34 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@122:36 | 122:36 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@128:32 | 128:32 | 7 | 100.00% | 7.0000 | Pass |
| anonymous@129:56 | 129:56 | 7 | 100.00% | 7.0000 | Pass |
| anonymous@135:48 | 135:48 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@143:43 | 143:43 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@143:75 | 143:75 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@143:98 | 143:98 | 1 | 0.00% | 2.0000 | Pass |
| functionResults | 150:8 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@151:24 | 151:24 | 3 | 100.00% | 3.0000 | Pass |

### .ai/skills/check-code-quality/scripts/metrics.mjs

SHA-256: `5494299e856ff10c756f9910106396f784d1f96f2461a27202687a13ffb748bc`.

| Function | Line:column | Complexity | Body line coverage | CRAP | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| hash | 12:14 | 1 | 100.00% | 1.0000 | Pass |
| collectCoverage | 32:1 | 6 | 100.00% | 6.0000 | Pass |
| anonymous@36:40 | 36:40 | 1 | 100.00% | 1.0000 | Pass |
| findCoverage | 53:1 | 6 | 100.00% | 6.0000 | Pass |
| coverageEntry | 65:1 | 6 | 100.00% | 6.0000 | Pass |
| anonymous@67:49 | 67:49 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@68:45 | 68:45 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@69:23 | 69:23 | 3 | 100.00% | 3.0000 | Pass |
| textReport | 78:1 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@79:37 | 79:37 | 3 | 100.00% | 3.0000 | Pass |
| anonymous@85:30 | 85:30 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@85:81 | 85:81 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@86:40 | 86:40 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@86:55 | 86:55 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@87:55 | 87:55 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@87:101 | 87:101 | 1 | 0.00% | 2.0000 | Pass |
| parseInput | 92:1 | 16 | 100.00% | 16.0000 | Pass |
| anonymous@102:28 | 102:28 | 1 | 100.00% | 1.0000 | Pass |
| testPaths | 111:1 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@112:20 | 112:20 | 3 | 100.00% | 3.0000 | Pass |
| readMeasurements | 121:1 | 5 | 100.00% | 5.0000 | Pass |
| removeTemporary | 132:1 | 3 | 66.67% | 3.3333 | Pass |
| runMetrics | 138:8 | 20 | 95.65% | 20.0329 | Pass |

### scripts/changed-functions.test.mjs

SHA-256: `2149ed185dd495d8cff57ea466002a14a7c3c725793bd2b9625084ed3d25fd50`.

| Function | Line:column | Complexity | Body line coverage | CRAP | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| anonymous@9:89 | 9:89 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@17:81 | 17:81 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@28:85 | 28:85 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@31:67 | 31:67 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@32:99 | 32:99 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@35:85 | 35:85 | 1 | 100.00% | 1.0000 | Pass |
| repo | 47:1 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@49:11 | 49:11 | 1 | 100.00% | 1.0000 | Pass |
| git | 50:15 | 1 | 100.00% | 1.0000 | Pass |
| write | 54:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@62:85 | 62:85 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@75:37 | 75:37 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@79:31 | 79:31 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@82:76 | 82:76 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@96:87 | 96:87 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@101:17 | 101:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@104:87 | 104:87 | 1 | 100.00% | 1.0000 | Pass |
| invoke | 107:18 | 1 | 100.00% | 1.0000 | Pass |
| write | 108:34 | 1 | 0.00% | 2.0000 | Pass |
| write | 108:82 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@118:93 | 118:93 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@128:83 | 128:83 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@150:66 | 150:66 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@151:36 | 151:36 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@154:24 | 154:24 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@156:24 | 156:24 | 1 | 100.00% | 1.0000 | Pass |

### scripts/metrics.test.mjs

SHA-256: `1c4f877fdfa6b57a1c9f9c32f4f724c988c3bbd79ce78db91b7e5fcea9dbed5f`.

| Function | Line:column | Complexity | Body line coverage | CRAP | Action |
| --- | ---: | ---: | ---: | ---: | --- |
| anonymous@11:91 | 11:91 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@25:92 | 25:92 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@33:59 | 33:59 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@36:94 | 36:94 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@41:17 | 41:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@44:84 | 44:84 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@55:56 | 55:56 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@60:85 | 60:85 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@62:34 | 62:34 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@65:100 | 65:100 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@73:17 | 73:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@74:17 | 74:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@75:17 | 75:17 | 1 | 100.00% | 1.0000 | Pass |
| coverageFor | 78:1 | 2 | 100.00% | 2.0000 | Pass |
| point | 79:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@86:45 | 86:45 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@87:41 | 87:41 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@88:53 | 88:53 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@89:42 | 89:42 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@93:94 | 93:94 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@106:31 | 106:31 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@111:93 | 111:93 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@124:83 | 124:83 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@133:80 | 133:80 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@150:76 | 150:76 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@153:17 | 153:17 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@155:5 | 155:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@156:5 | 156:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@157:5 | 157:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@158:5 | 158:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@162:19 | 162:19 | 1 | 100.00% | 1.0000 | Pass |
| fixture | 166:1 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@168:11 | 168:11 | 1 | 100.00% | 1.0000 | Pass |
| invoke | 177:1 | 2 | 100.00% | 2.0000 | Pass |
| write | 180:22 | 1 | 100.00% | 1.0000 | Pass |
| write | 180:70 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@185:92 | 185:92 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@202:68 | 202:68 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@213:68 | 213:68 | 2 | 100.00% | 2.0000 | Pass |
| runTests | 220:78 | 1 | 0.00% | 2.0000 | Pass |
| anonymous@226:89 | 226:89 | 2 | 100.00% | 2.0000 | Pass |
| runTests | 234:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@245:95 | 245:95 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@270:84 | 270:84 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@280:88 | 280:88 | 1 | 100.00% | 1.0000 | Pass |
| runTests | 287:5 | 1 | 100.00% | 1.0000 | Pass |
| anonymous@304:91 | 304:91 | 3 | 100.00% | 3.0000 | Pass |
| runTests | 312:7 | 2 | 100.00% | 2.0000 | Pass |
| anonymous@325:72 | 325:72 | 1 | 100.00% | 1.0000 | Pass |

