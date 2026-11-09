import type { mergeWriteAgentAccounts as MergeAccounts } from '../../src/workspace/agent-accounts.ts';
import type { resolveHome as ResolveHome } from '../../src/home/resolve.ts';

export async function probe({ mergeWriteAgentAccounts, resolveHome }: {
  mergeWriteAgentAccounts: typeof MergeAccounts;
  resolveHome: typeof ResolveHome;
}, value: string): Promise<void> {
  const selectedHome = resolveHome({ purpose: 'cli' });
  await mergeWriteAgentAccounts(store => { store.legacy = value; }, selectedHome);
}
