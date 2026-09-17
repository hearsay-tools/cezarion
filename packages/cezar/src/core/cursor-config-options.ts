import { z } from 'zod';

// Cursor 2026.09.15 represents model parameters (including booleans) as select options.
// Unknown option types are ignored; malformed select snapshots never replace known state.
const selectSchema = z.object({
  id: z.string().min(1),
  type: z.literal('select'),
  currentValue: z.string(),
  options: z.array(z.object({ value: z.string(), name: z.string() })),
});
export type CursorConfigOption = z.infer<typeof selectSchema>;
export function parseCursorConfigOptions(value: unknown): CursorConfigOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: CursorConfigOption[] = [];
  for (const row of value) {
    if (row && typeof row === 'object' && 'type' in row && row.type !== 'select') continue;
    const parsed = selectSchema.safeParse(row);
    if (!parsed.success) return undefined;
    result.push(parsed.data);
  }
  return result;
}

/** Match the model's advertised parameter and exact value; never translate a boolean toggle. */
export function cursorEffortSelection(options: readonly CursorConfigOption[], effort: string): { configId: string; value: string } {
  const option = options.find(option => ['effort', 'reasoning', 'reasoning_effort'].includes(option.id) && option.options.some(value => value.value === effort));
  if (!option) throw new Error(`Cursor's selected model does not advertise effort '${effort}'`);
  return { configId: option.id, value: effort };
}
