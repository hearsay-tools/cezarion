# Code quality check

Result: PASS.

Pinned baseline: `006f1712f0bb65dd24a8d51ee9487ed06db1f557`. Head: `88789c62d080dfeeac68e1489887b3becc78659f`.

Checked 211/211 changed functions across 9 files.
Limits: complexity > 20 or CRAP > 30. Equality passes.
Maximum complexity: 20. Maximum CRAP: 20.0328758116216.

CRAP uses executable function body line coverage, a line-coverage variant of the original basis-path metric.

## Reproduce

```json
{
  "cwd": "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c",
  "argv": [
    "/home/agent/.nvm/versions/node/v24.21.0/bin/node",
    "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c/.ai/skills/check-code-quality/scripts/check.mjs",
    "--base",
    "origin/main",
    "--runner",
    "node",
    "--test",
    "scripts/metrics.test.mjs",
    "--test",
    "scripts/changed-functions.test.mjs",
    "--test",
    "scripts/quality-check.test.mjs",
    "--node-import",
    "scripts/test-git-env.mjs",
    "--output",
    ".ai/analysis/2026-10-23-code-quality-check.md",
    "--json"
  ]
}
```

## Measurement

```json
{
  "runner": "node",
  "command": [
    "/home/agent/.nvm/versions/node/v24.21.0/bin/node",
    "--import",
    "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c/scripts/test-git-env.mjs",
    "--test",
    "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c/scripts/metrics.test.mjs",
    "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c/scripts/changed-functions.test.mjs",
    "/home/agent/projects/cezar/.ai/cezar/worktrees/9cb752d0-e654-4d7b-8a9d-9712c960f76c/scripts/quality-check.test.mjs"
  ],
  "environment": {
    "NODE_V8_COVERAGE": "<temporary-directory>/raw"
  }
}
```

## .ai/skills/check-code-quality/scripts/changed-functions.mjs

SHA-256: `ea6a9daab76c85b4e5b498b848bda3cc06a9ab06f82be6fd0e5c3fa621a06364`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | exceededMetrics (12:8) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@13:44 (13:44) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@15:9 (15:9) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | normalizeName (18:23) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | identity (19:1) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@20:27 (20:27) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@21:21 (21:21) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | ownSource (26:1) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@28:40 (28:40) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | compareFunctions (36:8) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@40:28 (40:28) | 11 | 100.00% | 11.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@42:44 (42:44) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@44:37 (44:37) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | scanChanges (58:8) | 7 | 100.00% | 7.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | git (59:15) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | pinnedGit (66:21) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | anonymous@70:12 (70:12) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/changed-functions.mjs | runChangedFunctions (87:8) | 10 | 80.00% | 10.8000 | Pass |

## .ai/skills/check-code-quality/scripts/check.mjs

SHA-256: `98929b3ac1d6ed59e3367033e351f11b3fc9356146a8af918418049dc42d4e2c`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/check.mjs | localFile (28:1) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | validateRunner (34:1) | 12 | 100.00% | 12.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | anonymous@39:28 (39:28) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | parseInput (42:1) | 14 | 100.00% | 14.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | anonymous@55:41 (55:41) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | anonymous@56:18 (56:18) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | anonymous@57:53 (57:53) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | verifySnapshot (61:1) | 4 | 100.00% | 4.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | saveReport (69:1) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | runCheck (81:8) | 19 | 93.33% | 19.1070 | Pass |
| .ai/skills/check-code-quality/scripts/check.mjs | anonymous@96:87 (96:87) | 1 | 100.00% | 1.0000 | Pass |

## .ai/skills/check-code-quality/scripts/code-metrics.mjs

SHA-256: `986a1209019baca426486cbc844639d40518d23f7c3ca7b4dab63d1852b067c3`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | childNodes (14:1) | 8 | 100.00% | 8.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | functionName (22:1) | 20 | 100.00% | 20.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@28:40 (28:40) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | analyzeSource (39:8) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | visit (47:3) | 18 | 100.00% | 18.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@76:25 (76:25) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | selectFunctions (79:8) | 11 | 100.00% | 11.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@82:32 (82:32) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@85:32 (85:32) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@86:13 (86:13) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@92:92 (92:92) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | unavailable (97:21) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | isRecord (98:18) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | measureCoverage (101:8) | 13 | 100.00% | 13.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@102:70 (102:70) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | offset (107:3) | 9 | 100.00% | 9.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@115:38 (115:38) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@116:41 (116:41) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@121:34 (121:34) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@122:36 (122:36) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@128:32 (128:32) | 7 | 100.00% | 7.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@129:56 (129:56) | 7 | 100.00% | 7.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@135:48 (135:48) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@143:43 (143:43) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@143:75 (143:75) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@143:98 (143:98) | 1 | 0.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | functionResults (150:8) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/code-metrics.mjs | anonymous@151:24 (151:24) | 3 | 100.00% | 3.0000 | Pass |

## .ai/skills/check-code-quality/scripts/coverage.mjs

SHA-256: `0f8161e169bd76300ecb484b030cc5e0fba6ae0102b11523a160ee3327ae40d0`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/coverage.mjs | vitestArguments (10:1) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@13:43 (13:43) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@16:22 (16:22) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | execute (20:1) | 6 | 100.00% | 6.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | convertNodeCoverage (34:8) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@35:38 (35:38) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@36:42 (36:42) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@36:78 (36:78) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@38:41 (38:41) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | collectCoverage (51:8) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@59:18 (59:18) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/coverage.mjs | anonymous@64:36 (64:36) | 1 | 100.00% | 1.0000 | Pass |

## .ai/skills/check-code-quality/scripts/metrics.mjs

SHA-256: `5494299e856ff10c756f9910106396f784d1f96f2461a27202687a13ffb748bc`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/metrics.mjs | hash (12:14) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | collectCoverage (32:1) | 6 | 100.00% | 6.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@36:40 (36:40) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | findCoverage (53:1) | 6 | 100.00% | 6.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | coverageEntry (65:1) | 6 | 100.00% | 6.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@67:49 (67:49) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@68:45 (68:45) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@69:23 (69:23) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | textReport (78:1) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@79:37 (79:37) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@85:30 (85:30) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@85:81 (85:81) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@86:40 (86:40) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@86:55 (86:55) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@87:55 (87:55) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@87:101 (87:101) | 1 | 0.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | parseInput (92:1) | 16 | 100.00% | 16.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@102:28 (102:28) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | testPaths (111:1) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | anonymous@112:20 (112:20) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | readMeasurements (121:1) | 5 | 100.00% | 5.0000 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | removeTemporary (132:1) | 3 | 66.67% | 3.3333 | Pass |
| .ai/skills/check-code-quality/scripts/metrics.mjs | runMetrics (138:8) | 20 | 95.65% | 20.0329 | Pass |

## .ai/skills/check-code-quality/scripts/quality-report.mjs

SHA-256: `e4b2a018c42b50258011c735fd453c1845a0a1f887387516680c5a0d34d99bc1`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | identity (4:18) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | measureFile (6:8) | 3 | 100.00% | 3.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | write (9:27) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@14:50 (14:50) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@15:40 (15:40) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | finishReport (23:8) | 6 | 100.00% | 6.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@24:35 (24:35) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@25:36 (25:36) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@26:37 (26:37) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@27:38 (27:38) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@35:44 (35:44) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@36:38 (36:38) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | maximum (41:1) | 2 | 100.00% | 2.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | cell (42:14) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | functionRow (44:1) | 5 | 100.00% | 5.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | markdownReport (51:8) | 8 | 100.00% | 8.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@63:80 (63:80) | 1 | 100.00% | 1.0000 | Pass |
| .ai/skills/check-code-quality/scripts/quality-report.mjs | anonymous@68:29 (68:29) | 1 | 100.00% | 1.0000 | Pass |

## scripts/changed-functions.test.mjs

SHA-256: `2149ed185dd495d8cff57ea466002a14a7c3c725793bd2b9625084ed3d25fd50`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| scripts/changed-functions.test.mjs | anonymous@9:89 (9:89) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@17:81 (17:81) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@28:85 (28:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@31:67 (31:67) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@32:99 (32:99) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@35:85 (35:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | repo (47:1) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@49:11 (49:11) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | git (50:15) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | write (54:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@62:85 (62:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@75:37 (75:37) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@79:31 (79:31) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@82:76 (82:76) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@96:87 (96:87) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@101:17 (101:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@104:87 (104:87) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | invoke (107:18) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | write (108:34) | 1 | 0.00% | 2.0000 | Pass |
| scripts/changed-functions.test.mjs | write (108:82) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@118:93 (118:93) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@128:83 (128:83) | 2 | 100.00% | 2.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@150:66 (150:66) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@151:36 (151:36) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@154:24 (154:24) | 1 | 100.00% | 1.0000 | Pass |
| scripts/changed-functions.test.mjs | anonymous@156:24 (156:24) | 1 | 100.00% | 1.0000 | Pass |

## scripts/metrics.test.mjs

SHA-256: `1c4f877fdfa6b57a1c9f9c32f4f724c988c3bbd79ce78db91b7e5fcea9dbed5f`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| scripts/metrics.test.mjs | anonymous@11:91 (11:91) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@25:92 (25:92) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@33:59 (33:59) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@36:94 (36:94) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@41:17 (41:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@44:84 (44:84) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@55:56 (55:56) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@60:85 (60:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@62:34 (62:34) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@65:100 (65:100) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@73:17 (73:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@74:17 (74:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@75:17 (75:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | coverageFor (78:1) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | point (79:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@86:45 (86:45) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@87:41 (87:41) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@88:53 (88:53) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@89:42 (89:42) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@93:94 (93:94) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@106:31 (106:31) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@111:93 (111:93) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@124:83 (124:83) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@133:80 (133:80) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@150:76 (150:76) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@153:17 (153:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@155:5 (155:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@156:5 (156:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@157:5 (157:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@158:5 (158:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@162:19 (162:19) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | fixture (166:1) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@168:11 (168:11) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | invoke (177:1) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | write (180:22) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | write (180:70) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@185:92 (185:92) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@202:68 (202:68) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@213:68 (213:68) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | runTests (220:78) | 1 | 0.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@226:89 (226:89) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | runTests (234:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@245:95 (245:95) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@270:84 (270:84) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@280:88 (280:88) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | runTests (287:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@304:91 (304:91) | 3 | 100.00% | 3.0000 | Pass |
| scripts/metrics.test.mjs | runTests (312:7) | 2 | 100.00% | 2.0000 | Pass |
| scripts/metrics.test.mjs | anonymous@325:72 (325:72) | 1 | 100.00% | 1.0000 | Pass |

## scripts/quality-check.test.mjs

SHA-256: `ff79847e9821ecb357f8a3c41e3719a840cbdcc290e18c7a89d1dd94371b1410`.

| File | Function (line:column) | Complexity | Body line coverage | CRAP | Action |
| --- | --- | ---: | ---: | ---: | --- |
| scripts/quality-check.test.mjs | fixture (14:1) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@16:11 (16:11) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | git (17:15) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | write (18:17) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | coverage (35:1) | 3 | 100.00% | 3.0000 | Pass |
| scripts/quality-check.test.mjs | invoke (48:1) | 3 | 100.00% | 3.0000 | Pass |
| scripts/quality-check.test.mjs | write (51:34) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | write (51:82) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@57:100 (57:100) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@80:71 (80:71) | 2 | 100.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@96:65 (96:65) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@113:93 (113:93) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | collect (118:5) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@133:77 (133:77) | 2 | 100.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | collect (138:7) | 2 | 100.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@153:71 (153:71) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | measure (157:14) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@164:85 (164:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@174:95 (174:95) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@198:61 (198:61) | 2 | 100.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | collect (206:53) | 1 | 0.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@212:65 (212:65) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | collect (215:49) | 1 | 0.00% | 2.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@221:93 (221:93) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@232:85 (232:85) | 1 | 100.00% | 1.0000 | Pass |
| scripts/quality-check.test.mjs | anonymous@248:82 (248:82) | 1 | 100.00% | 1.0000 | Pass |

