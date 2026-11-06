import { expect, it, vi } from 'vitest';
import * as homes from './resolve.ts';

it('prints global CLI help without resolving a Home', async () => {
  const argv = process.argv;
  const resolve = vi.spyOn(homes, 'resolveHome');
  let printed!: () => void;
  const help = new Promise<void>(done => { printed = done; });
  const log = vi.spyOn(console, 'log').mockImplementation(message => {
    if (String(message).startsWith('cezar —')) printed();
  });
  process.argv = [process.execPath, 'cez', '--help'];
  try {
    await import('../index.ts');
    await help;
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
  }
});
