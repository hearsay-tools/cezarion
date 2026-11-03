# Expression arrow coverage fixture

`coverage.json` comes from Vitest 4.1.10 with its V8 provider. Only the absolute
report key and `path` were changed to `source.ts`. Null end columns are preserved.
The fixture calls `single` twice, `multi` once and `unused` zero times.

Regenerate from the repository root:

```sh
npm test -- --config "$PWD/.ai/skills/check-code-quality/scripts/fixtures/expression-arrows/vitest.config.ts" \
  --root "$PWD/.ai/skills/check-code-quality/scripts/fixtures/expression-arrows" \
  --coverage --coverage.include=source.ts --coverage.reporter=json \
  --coverage.reportsDirectory=coverage
```

Copy the resulting `coverage/coverage-final.json` to `coverage.json`, replacing
only the absolute report key and `path` with `source.ts`.
