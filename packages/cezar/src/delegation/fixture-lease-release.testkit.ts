import type { DatabaseSync } from 'node:sqlite';

export function releaseFixtureLease(db: DatabaseSync, id: string, token: string): void {
  db.exec('PRAGMA busy_timeout=1000');
  const result = db.prepare('DELETE FROM holders WHERE id = ? AND token = ?').run(id, token);
  if (result.changes !== 1) throw new Error('Fixture lease ownership changed');
}
