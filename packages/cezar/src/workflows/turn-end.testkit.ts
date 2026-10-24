import { expect } from 'vitest';
import { cezarWaitRequestSchema } from '@open-mercato/cezar-contract/waits';

/** Check the advertised kinds against the tool's input contract, including missing kinds. */
export function expectNoWaitNudgeKinds(text: string): void {
  const advertised = /cezar_wait \(([^)]+)\)/.exec(text);
  expect(advertised, 'the nudge must list cezar_wait kinds').not.toBeNull();
  const kinds = advertised![1]!.split(/,\s*|\s+or\s+/);
  const accepted = cezarWaitRequestSchema.options.map(option => option.shape.kind.value);
  expect(kinds.sort(), 'the nudge must advertise exactly the accepted wait kinds').toEqual(accepted.sort());
}
