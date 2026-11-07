import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

const changes = new EventEmitter();
/** Process-local notification; demand-bound filesystem watches cover other processes. */
export function homeChanged(root: string): void { changes.emit(resolve(root)); }
export function onHomeChange(root: string, listener: () => void): () => void {
  const key = resolve(root);
  changes.on(key, listener);
  return () => { changes.off(key, listener); };
}
