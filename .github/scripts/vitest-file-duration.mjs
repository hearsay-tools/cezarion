export const FILE_DURATION_LIMIT_MS = 60_000;

/** CI shard guard. Read live module execution time, including hooks and teardown. */
export default class FileDurationReporter {
  pending = new Set();
  failures = [];

  onTestRunStart() {
    this.pending.clear();
    this.failures = [];
  }

  onTestModuleCollected(module) {
    this.pending.add(module);
  }

  onTestModuleEnd(module) {
    this.pending.delete(module);
    const duration = module.diagnostic().duration;
    const state = module.state();
    if (!['passed', 'failed', 'skipped'].includes(state) || !Number.isFinite(duration) || duration < 0) {
      this.failures.push(`${module.moduleId}: no completed result (${duration} ms; limit ${FILE_DURATION_LIMIT_MS} ms)`);
    } else if (duration >= FILE_DURATION_LIMIT_MS) {
      this.failures.push(`${module.moduleId}: ${duration} ms; limit ${FILE_DURATION_LIMIT_MS} ms (must be below limit)`);
    }
  }

  onTestRunEnd() {
    for (const module of this.pending) {
      this.failures.push(`${module.moduleId}: no completed result (unmeasured ms; limit ${FILE_DURATION_LIMIT_MS} ms)`);
    }
    if (this.failures.length) {
      throw new Error(`Vitest file duration cap failed:\n${this.failures.join('\n')}`);
    }
  }
}
