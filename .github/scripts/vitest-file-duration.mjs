import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FILE_DURATION_LIMIT_MS = 60_000;
// The failed-file list a merge-group rerun reads (vitest-rerun-reset.cjs): a file over the cap
// passes its tests, so Vitest's results cache does not mark it failed.
export const CAP_FAILURES_FILE = join('node_modules', '.vite', 'vitest', 'file-duration-cap.txt');

/** CI shard guard. Read live module execution time, including hooks and teardown. */
export default class FileDurationReporter {
  pending = new Set();
  failures = [];
  failedFiles = [];

  onInit(vitest) {
    this.list = join(vitest.config.root, CAP_FAILURES_FILE);
  }

  onTestRunStart() {
    this.pending.clear();
    this.failures = [];
    this.failedFiles = [];
    if (this.list) rmSync(this.list, { force: true });
  }

  onTestModuleCollected(module) {
    this.pending.add(module);
  }

  onTestModuleEnd(module) {
    this.pending.delete(module);
    const duration = module.diagnostic().duration;
    const state = module.state();
    if (!['passed', 'failed', 'skipped'].includes(state) || !Number.isFinite(duration) || duration < 0) {
      this.fail(module, `no completed result (${duration} ms; limit ${FILE_DURATION_LIMIT_MS} ms)`);
    } else if (duration >= FILE_DURATION_LIMIT_MS) {
      this.fail(module, `${duration} ms; limit ${FILE_DURATION_LIMIT_MS} ms (must be below limit)`);
    }
  }

  fail(module, reason) {
    this.failures.push(`${module.moduleId}: ${reason}`);
    this.failedFiles.push(module.moduleId);
  }

  onTestRunEnd() {
    for (const module of this.pending) this.fail(module, `no completed result (unmeasured ms; limit ${FILE_DURATION_LIMIT_MS} ms)`);
    if (this.failures.length) {
      console.error(`Vitest file duration cap failed:\n${this.failures.join('\n')}`);
      process.exitCode = 1;
      if (this.list) {
        mkdirSync(join(this.list, '..'), { recursive: true });
        writeFileSync(this.list, this.failedFiles.map((file) => `${file}\n`).join(''));
      }
    }
  }
}
