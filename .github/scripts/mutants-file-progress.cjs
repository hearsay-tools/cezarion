'use strict';
const INTERVAL = 30_000;
const PLUGIN_FILE = 'cezar-mutation-progress.cjs';
const runtime = () => ({ now: Date.now, log: console.log, setInterval, clearInterval });

/** A heartbeat also covers setup and Stryker's dry run, before a total exists. */
function startProgress(phase, clock = runtime(), count = () => 'unknown') {
  const started = clock.now();
  const render = () => clock.log(`${phase}: mutants ${count()}, elapsed ${Math.floor((clock.now() - started) / 1000)}s`);
  render();
  const timer = clock.setInterval(render, INTERVAL);
  timer.unref?.();
  return () => { clock.clearInterval(timer); };
}

class ProgressReporter {
  static inject = [];
  constructor(clock = runtime()) {
    this.clock = clock;
    this.total = undefined;
    this.done = new Set();
    this.finish = startProgress('Mutation pass', clock, () => this.total === undefined ? 'unknown' : `${this.done.size}/${this.total}`);
  }
  onMutationTestingPlanReady({ mutantPlans }) {
    this.ids = new Set(mutantPlans.map(plan => plan.mutant.id));
    this.total = this.ids.size;
  }
  onMutantTested(mutant) {
    if (this.ids?.has(mutant.id)) this.done.add(mutant.id);
  }
  onMutationTestReportReady() {
    this.clock.log(`Mutation pass complete: mutants ${this.done.size}/${this.total ?? 'unknown'}`);
    this.wrapUp();
  }
  wrapUp() { this.finish(); }
}

function progressConfig(config) {
  return { ...config, plugins: [...(config.plugins ?? []), `./${PLUGIN_FILE}`], reporters: [...(config.reporters ?? []), 'cezar-progress'] };
}
// A standalone CommonJS plugin also works when copied into an older committed checkout.
exports.strykerPlugins = [{ kind: 'Reporter', name: 'cezar-progress', injectableClass: ProgressReporter }];
exports.ProgressReporter = ProgressReporter;
exports.startProgress = startProgress;
exports.progressConfig = progressConfig;
exports.PLUGIN_FILE = PLUGIN_FILE;
