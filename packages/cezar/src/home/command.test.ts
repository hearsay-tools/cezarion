import { describe, expect, it } from 'vitest';
import { cliCommand, commandText, invokedCommand, oldCommandNotice } from './command.ts';
import { productIdentity } from './identity.ts';

it('recognizes only the historical alias bin.js', () => {
  const alias = productIdentity(false).npmAlias;
  for (const modules of ['/prefix/lib/node_modules', '/cache/_npx/abc123/node_modules',
    'C:/npm/node_modules', 'C:/cache/_npx/abc123/node_modules']) {
    for (const separator of ['/', '\\']) {
      const entry = `${modules}/${alias}/bin.js`.replaceAll('/', separator);
      expect(invokedCommand(entry)).toBe(alias);
      expect(cliCommand(entry)).toBe(alias);
      expect(oldCommandNotice(entry)).toBe(`[${alias}] '${alias}' is deprecated; use 'hsq' instead.`);
      for (const parent of ['foreign', `${alias}-x`]) {
        const foreign = `${modules}/${parent}/bin.js`.replaceAll('/', separator);
        expect(invokedCommand(foreign)).toBeUndefined();
        expect(oldCommandNotice(foreign)).toBeUndefined();
      }
    }
  }
});

describe('invoked binary identity', () => {
  it.each(['cez', 'cezarion', 'hsq'] as const)('recognizes %s through npm and managed entry paths', name => {
    for (const entry of [`/bin/${name}`, `/pkg/dist/${name}.js`, `C:\\npm\\${name}.cmd`, `C:\\bin\\${name}.exe`]) {
      expect(invokedCommand(entry)).toBe(name);
      expect(cliCommand(entry)).toBe(name);
    }
  });
  it.each(['', '/bin/cezar-cli', '/bin/foreign-cez', '/bin/hsq.js.bak', '/pkg/dist/index.ts', '/pkg/dist/index.cmd'])('does not infer a binary from %j', entry => {
    expect(invokedCommand(entry)).toBeUndefined();
    expect(cliCommand(entry)).toBe('hsq');
    expect(oldCommandNotice(entry)).toBeUndefined();
  });
  it.each([
    'index.js', 'dist/index.js', '/pkg/dist/index.js',
    String.raw`C:\Users\operator\AppData\Roaming\npm\node_modules\@wjarka\cezarion\dist\index.js`,
    String.raw`D:\npm prefix\node_modules\@wjarka\cezarion\dist\index.js`,
    'C:/npm/node_modules/@wjarka/cezarion/dist/index.js',
  ])('treats the old target passed by npm wrappers as cez: %s', entry => {
    expect(invokedCommand(entry)).toBe('cez');
    expect(cliCommand(entry)).toBe('cez');
    expect(oldCommandNotice(entry)).toBe("[cez] 'cez' is deprecated; use 'hsq' instead.");
    expect(commandText('Usage: cez run\nRun hsq migrate', entry)).toBe('Usage: cez run\nRun cez migrate');
  });
  it.each(['cez', 'cezarion', 'hsq'])('renders %s help without renaming paths or product prose', name => {
    const text = 'cezar — cockpit\nUsage: cez run\nRun hsq migrate\n.ai/cezar/config.json';
    expect(commandText(text, `/pkg/${name}.js`)).toBe(`cezar — cockpit\nUsage: ${name} run\nRun ${name} migrate\n.ai/cezar/config.json`);
    expect(commandText('cezarion', `/pkg/${name}.js`)).toBe(name);
    expect(oldCommandNotice(name)).toBe(name === 'hsq' ? undefined : `[${name}] '${name}' is deprecated; use 'hsq' instead.`);
  });
});

it('rewrites standalone command examples before backticks and at end of text', () => {
  const text = 'Run `cez` or `hsq`; finish with cez';
  expect(commandText(text, '/bin/hsq')).toBe('Run `hsq` or `hsq`; finish with hsq');
  expect(commandText(text, '/bin/cezarion')).toBe('Run `cezarion` or `cezarion`; finish with cezarion');
});

it('preserves path tokens in command examples', () => {
  const text = String.raw`Run cez inspect /tmp/cez /tmp/hsq C:\tools\cez ./hsq tools-cez`;
  expect(commandText(text, '/bin/hsq')).toBe(text.replace('Run cez', 'Run hsq'));
});

it('runs the scoped package in one-off npx examples', () => {
  expect(commandText('Start the cockpit with: npx cezarion', '/bin/hsq')).toBe('Start the cockpit with: npx -p @hearsay-tools/squawk hsq');
  expect(commandText('Run `npx cezarion@1.2.3 run`', '/bin/cez')).toBe('Run `npx -p @hearsay-tools/squawk@1.2.3 hsq run`');
  expect(commandText('npx cezarion-foreign', '/bin/hsq')).toBe('npx cezarion-foreign');
});
