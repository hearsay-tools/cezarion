import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { dirname, join, relative } from 'node:path';

/** Floor-only diagnostics: preserve the ordinary reporters and the test verdict. */
export default class NodeFloorReporter {
  constructor(options = {}) {
    this.options = options;
    this.activeModules = new Set();
  }

  onInit(ctx) {
    this.ctx = ctx;
    this.outputFile = this.options.outputFile ?? join(
      process.env.RUNNER_TEMP ?? join(ctx.config.root, '.ai/qa'),
      `node-floor-shard-${ctx.config.shard?.index ?? 1}.json`,
    );
  }

  onTestRunStart(specifications) {
    this.started = performance.now();
    this.activeModules.clear();
    this.report = {
      nodeVersion: process.version,
      shard: this.ctx.config.shard ?? null,
      maxWorkers: this.ctx.config.maxWorkers,
      availableParallelism: availableParallelism(),
      logicalCpus: cpus().length,
      fileCount: specifications.length,
      peakActiveModules: 0,
      reason: 'running',
      durationMs: 0,
      samples: [],
      tests: [],
      modules: [],
    };
    this.sample();
    this.timer = setInterval(() => this.sample(), this.options.sampleIntervalMs ?? 10_000);
    this.timer.unref();
    console.log(`[node-floor] node=${process.version} workers=${this.report.maxWorkers} cpus=${this.report.availableParallelism} shard=${JSON.stringify(this.report.shard)} load=${loadavg().join(',')}`);
  }

  sample() {
    this.report.durationMs = Math.round(performance.now() - this.started);
    this.report.samples.push({ elapsedMs: this.report.durationMs, loadAverage: loadavg() });
    mkdirSync(dirname(this.outputFile), { recursive: true });
    // A periodic snapshot also survives a job-level timeout before onTestRunEnd.
    writeFileSync(this.outputFile, JSON.stringify(this.report));
  }

  onTestModuleStart(module) {
    this.activeModules.add(module.id);
    this.report.peakActiveModules = Math.max(this.report.peakActiveModules, this.activeModules.size);
  }

  onTestModuleEnd(module) {
    this.activeModules.delete(module.id);
    this.report.modules.push({
      project: module.project.name,
      file: relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
      state: module.state(),
      durationMs: module.diagnostic().duration,
    });
  }

  onTestCaseResult(test) {
    const diagnostic = test.diagnostic();
    const result = test.result();
    this.report.tests.push({
      project: test.project.name,
      file: relative(this.ctx.config.root, test.module.moduleId).replaceAll('\\', '/'),
      name: test.fullName,
      state: result.state,
      errorMessages: result.errors?.map(error => error.message) ?? [],
      startTime: diagnostic?.startTime ?? null,
      durationMs: diagnostic?.duration ?? 0,
      timeoutMs: test.options.timeout ?? test.project.config.testTimeout,
      retryCount: diagnostic?.retryCount ?? 0,
    });
  }

  onTestRunEnd(_modules, errors, reason) {
    clearInterval(this.timer);
    this.report.reason = reason;
    this.report.unhandledErrors = errors.length;
    this.sample();
    const nearTimeout = this.report.tests.filter(test => test.state === 'failed'
      || (test.timeoutMs > 0 && test.durationMs >= test.timeoutMs * 0.8));
    console.log(`[node-floor] elapsed=${this.report.durationMs}ms peakModules=${this.report.peakActiveModules} failed-or-near-timeout=${nearTimeout.length} evidence=${this.outputFile}`);
    for (const test of nearTimeout) {
      console.log(`[node-floor] ${test.state} ${test.durationMs.toFixed(1)}/${test.timeoutMs}ms ${test.project} ${test.file} > ${test.name}`);
    }
  }
}
