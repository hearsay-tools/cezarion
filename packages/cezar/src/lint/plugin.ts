import { testWaitDiscipline } from './test-wait-discipline.ts';
import { card2Contrast } from './card-2-contrast.ts';
import { contractRootImport } from './contract-root-import.ts';
import { designGuardian } from './design-guardian.ts';
import { nativeMockSource } from './native-mock-source.ts';
import { rawQuerySetter } from './raw-query-setter.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { oxlintRule, type SourceRule } from './source-rule.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: SourceRule[] = [card2Contrast, contractRootImport, designGuardian, nativeMockSource, rawQuerySetter, runFactReader, runHistoryReader, testWaitDiscipline, undocumentedEnvName];

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries(RULES.map((rule) => [rule.name, oxlintRule(rule)])),
};
