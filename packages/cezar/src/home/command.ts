import { BINARY_NAMES, npxCommand, productIdentity, type BinaryName } from './identity.ts';
import { REBRAND_SWITCH } from './switch.ts';

/** npm's Windows wrappers pass the old bin target, index.js, rather than their name. */
export function invokedCommand(entry: string | undefined = process.argv[1]): BinaryName | undefined {
  const parts = entry?.split(/[\\/]/);
  const basename = parts?.at(-1);
  if (basename === 'bin.js' && parts?.at(-2) === productIdentity(false).npmAlias) return productIdentity(false).npmAlias;
  if (basename === 'index.js') return productIdentity(false).command;
  const name = basename?.replace(/\.(?:js|cmd|exe)$/i, '');
  return BINARY_NAMES.find(binary => binary === name);
}

/** Old entry points retain their historical help until the release switch. */
export function cliCommand(entry: string | undefined = process.argv[1], rebrand = REBRAND_SWITCH): BinaryName {
  const invoked = invokedCommand(entry);
  if (invoked === 'hsq' || rebrand) return invoked ?? productIdentity(rebrand).command;
  return productIdentity(false).command;
}

/** Render command examples only; callers keep product prose and paths unchanged. */
export function commandText(text: string, entry: string | undefined = process.argv[1], rebrand = REBRAND_SWITCH): string {
  if (!rebrand && invokedCommand(entry) !== 'hsq') return text;
  if (text === 'cezarion' || text === 'cez') return cliCommand(entry, rebrand);
  return text.replace(/(?<![\w./\\-])\b(?:cez|hsq)(?=\s|\]|`|$)/g, cliCommand(entry, rebrand))
    .replace(/\bnpx cezarion(?:@([\w.-]+))?(?![\w@-])/g, (_, version?: string) => npxCommand(version, rebrand));
}

/** The dispatcher owns the one per-process notice, including task command invocations. */
export function oldCommandNotice(entry: string | undefined, rebrand = REBRAND_SWITCH): string | undefined {
  const invoked = invokedCommand(entry);
  if (!rebrand || invoked === undefined || invoked === 'hsq') return;
  return `[${invoked}] '${invoked}' is deprecated; use '${productIdentity(true).command}' instead.`;
}
