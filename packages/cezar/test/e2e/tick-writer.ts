/** Source shared by fake npm children; the final tick is observed after reaping. */
export function tickWriterSource(path: string): string {
  return `const tickPath = ${JSON.stringify(path)};
function writeTick(value) {
  // SIGKILL may interrupt any filesystem call: publish only a complete number.
  const pending = tickPath + '.pending';
  fs.writeFileSync(pending, String(value));
  fs.renameSync(pending, tickPath);
}`;
}
