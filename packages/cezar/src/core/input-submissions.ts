/** Accepted agent input whose model consumption has not been observed yet (#505).
 * One instance per session; FIFO so text matching takes the oldest first. */
export class InputSubmissions {
  private readonly entries: { id: string; inputIds: readonly string[]; text: string }[] = [];
  get pending(): number { return this.entries.length; }
  has(submissionId: string): boolean { return this.entries.some(entry => entry.id === submissionId); }
  accept(submissionId: string, inputIds: readonly string[], text: string): void {
    if (inputIds.length) this.entries.push({ id: submissionId, inputIds: [...inputIds], text });
  }
  consume(submissionId: string): readonly string[] {
    const at = this.entries.findIndex(entry => entry.id === submissionId);
    return at < 0 ? [] : this.entries.splice(at, 1)[0]!.inputIds;
  }
  consumeOldestByText(text: string): readonly string[] {
    const at = this.entries.findIndex(entry => entry.text === text);
    return at < 0 ? [] : this.entries.splice(at, 1)[0]!.inputIds;
  }
  takeUnconsumed(): readonly string[] {
    return this.entries.splice(0).flatMap(entry => entry.inputIds);
  }
}
