import { rmSync } from 'node:fs';
import { join } from 'node:path';

// Keeps test files in Vitest's coverage report.
//
// A coverage report measures changed test functions too, so it must hold the test files.
// Vitest appends every project's `test.include` globs to `coverage.exclude` after it resolves the
// config, and no setting turns that off. The root config's `projects` setting stops plugin hooks from
// reaching this file, so the working place is a reporter: `onInit` runs before any test starts.

/** True when the command line asks Vitest for coverage. A run without it never sees this reporter. */
export function coverageRequested(argv = process.argv) {
  return argv.some((argument) => argument === '--coverage' || argument.startsWith('--coverage.') || argument.startsWith('--coverage='));
}

export default class KeepTestFilesInCoverage {
  onInit(vitest) {
    const configs = [vitest.config, ...vitest.projects.map((project) => project.config)];
    const testGlobs = new Set(configs.flatMap((config) => config.include ?? []));
    const exclude = vitest.config.coverage.exclude.filter((glob) => !testGlobs.has(glob));
    vitest.config.coverage.exclude = exclude;
    // The provider copied its options before this hook ran.
    if (vitest.coverageProvider) {
      vitest.coverageProvider.options.exclude = exclude;
      if (process.env.GITHUB_ACTIONS === 'true') optionalCoverageReports(vitest.coverageProvider);
    }
  }
}

// Only report conversion and writing are optional. Provider startup, collection, test failures,
// unhandled errors and exit codes remain Vitest's responsibility.
export function optionalCoverageReports(provider) {
  let failed = false;
  for (const method of ['generateCoverage', 'reportCoverage']) {
    const original = provider[method];
    if (!original) continue;
    provider[method] = async (...args) => {
      if (failed) return;
      try {
        return await original.apply(provider, args);
      } catch (error) {
        failed = true;
        const detail = String(error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
        console.warn(`::warning title=Vitest coverage report failed::${detail}. Test results are unchanged.`);
        // A failed writer can leave a partial report. Never throw past cleanup.
        try {
          rmSync(join(provider.options.reportsDirectory, 'coverage-final.json'), { force: true });
        } catch {
          console.warn('::warning title=Vitest coverage cleanup failed::Could not remove the incomplete coverage report.');
        }
      }
    };
  }
}
