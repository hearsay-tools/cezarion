import { describe, expect, it } from 'vitest';
import { InputSubmissions } from './input-submissions.ts';

describe('InputSubmissions', () => {
  it('consumes once by submission id and reports the rest as unconsumed', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', ['a', 'b'], 'batch one');
    ledger.accept('s2', ['c'], 'batch two');
    expect(ledger.consume('s1')).toEqual(['a', 'b']);
    expect(ledger.consume('s1')).toEqual([]);
    expect(ledger.takeUnconsumed()).toEqual(['c']);
    expect(ledger.pending).toBe(0);
  });
  it('matches the oldest pending submission with identical text', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', ['a'], 'same'); ledger.accept('s2', ['b'], 'same');
    expect(ledger.consumeOldestByText('same')).toEqual(['a']);
    expect(ledger.consumeOldestByText('other')).toEqual([]);
    expect(ledger.takeUnconsumed()).toEqual(['b']);
  });
  it('ignores a submission without input ids', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', [], 'nudge');
    expect(ledger.pending).toBe(0);
  });
});

describe('InputSubmissions.has', () => {
  it('reports whether a submission is still pending', () => {
    const ledger = new InputSubmissions();
    ledger.accept('s1', ['a'], '');
    expect(ledger.has('s1')).toBe(true);
    ledger.consume('s1');
    expect(ledger.has('s1')).toBe(false);
  });
});
