/** Golden take-over commands shared by server and cockpit tests. */
export const sessionId = 's1';
export const commands = {
  claude: 'claude --resume s1',
  codex: 'codex resume s1',
  opencode: 'opencode --session s1',
  pi: 'pi --session s1',
  cursor: 'agent --resume s1',
  omp: 'omp --resume s1',
};

export const unsafeSessionIds = [
  '', 'a b', "a'b", 'a`id`', 'a && calc.exe', '$(id)', '-x', '--help', 'a'.repeat(201),
];
