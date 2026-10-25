/** Compile-time guard: disabling exactOptionalPropertyTypes makes the directive unused. */
interface OptionalValue {
  value?: string;
}

const omitted: OptionalValue = {};
const present: OptionalValue = { value: 'set' };
// @ts-expect-error An optional key accepts omission, not an explicit undefined value.
const invalid: OptionalValue = { value: undefined };

interface ClearableValue {
  value?: string | undefined;
}
const cleared: ClearableValue = { value: undefined };

void [omitted, present, invalid, cleared];
export {};
