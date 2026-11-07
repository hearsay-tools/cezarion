import { testHomeWrite } from './test-home-write.ts';
import { homeBoundary } from './home-boundary.ts';
import { card2Contrast } from './card-2-contrast.ts';
import { contractRootImport } from './contract-root-import.ts';
import { designGuardian } from './design-guardian.ts';
import { mockLifecycleBoundary } from './mock-lifecycle-boundary.ts';
import { mockScenarioBoundary } from './mock-scenario-boundary.ts';
import { nativeMockSource } from './native-mock-source.ts';
import { rawQuerySetter } from './raw-query-setter.ts';
import { runFactReader } from './run-fact-reader.ts';
import { runHistoryReader } from './run-history-reader.ts';
import { oxlintRule, type SourceRule } from './source-rule.ts';
import { testWaitDiscipline } from './test-wait-discipline.ts';
import { undocumentedEnvName } from './undocumented-env-name.ts';
import { unitWaitDiscipline } from './unit-wait-discipline.ts';

/** Every repository rule. `.oxlintrc.json` turns each one on as `cez/<name>`. */
export const RULES: SourceRule[] = [homeBoundary, testHomeWrite, card2Contrast, contractRootImport, designGuardian, mockLifecycleBoundary, mockScenarioBoundary, nativeMockSource, rawQuerySetter, runFactReader, runHistoryReader, testWaitDiscipline, undocumentedEnvName, unitWaitDiscipline];

/** The `cez` oxlint JS plugin (hearsay-tools/cezarion#2416). */
export default {
  meta: { name: 'cez' },
  rules: Object.fromEntries(RULES.map((rule) => [rule.name, oxlintRule(rule)])),
};
