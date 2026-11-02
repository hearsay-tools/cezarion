import { contractRootImport } from './contract-root-import.ts';
import { nativeMockSource } from './native-mock-source.ts';
import { rawQuerySetter } from './raw-query-setter.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { runFactReader } from './run-fact-reader.ts';
import { oxlintRule, type SourceRule } from './source-rule.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: SourceRule[] = [contractRootImport, nativeMockSource, rawQuerySetter, runFactReader, runHistoryReader, undocumentedEnvName];

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries(RULES.map((rule) => [rule.name, oxlintRule(rule)])),
};
