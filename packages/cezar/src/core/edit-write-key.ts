/** The lowercased key of an `edit`/`write` tool call, or null for any other tool. */
export function editWriteKey(name: string): 'edit' | 'write' | null {
  const key = name.toLowerCase();
  return key === 'edit' || key === 'write' ? key : null;
}
