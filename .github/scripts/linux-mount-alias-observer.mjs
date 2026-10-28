// CI-only observer. The existing probe supervisor owns and gates the target.
import { processStartToken } from '../../packages/cezar/src/detached-process.ts';
import { mappedHolder } from '../../packages/cezar/src/delegation/linux-mapped-holders.ts';
import { AliasWorkBudget } from '../../packages/cezar/src/delegation/linux-alias-model.ts';
import { prepareAliasScan, scanAliases, verifyAliasScan } from '../../packages/cezar/src/delegation/linux-alias-scan.ts';

const [root, pidText, name] = process.argv.slice(2);
const pid = Number(pidText);
if (!root?.startsWith('/') || !Number.isSafeInteger(pid) || pid <= 1 || !name) throw Error('invalid observer input');
const budget = new AliasWorkBudget();
const attempt = prepareAliasScan([root], budget);
const token = processStartToken(pid);
if (!token) throw Error('target incarnation unavailable');
const old = mappedHolder(pid, [root], budget);
const result = scanAliases(pid, token, attempt);
verifyAliasScan(attempt);
console.log(JSON.stringify({ case: name, oldMapped: old, current: result.outcome, scoped: !!result.scoped }));
if (name === 'private-bind-closed-fd' && (old !== 'clear' || result.outcome !== 'held')) {
  throw Error('mapping-only production observation did not establish old miss and new hold');
}
