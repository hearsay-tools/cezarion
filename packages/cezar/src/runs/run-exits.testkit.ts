import { takeRunExitViolations } from './run-exits.ts';

type Settled = { ok: true } | { ok: false; error: unknown };

async function settle(work: () => Promise<void>): Promise<Settled> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Runs `body`, then `cleanUp`, and always drains the run exit violations, so none reaches
 * fast-check's next run. When `body` threw, its error is the one reported. When it passed, a
 * cleanup error and every violation recorded, cleanup included, fail it together.
 */
export async function runThenCleanUp(body: () => Promise<void>, cleanUp: () => Promise<void>): Promise<void> {
  const ran = await settle(body);
  const cleaned = await settle(cleanUp);
  const violations = takeRunExitViolations();
  if (!ran.ok) throw ran.error;
  const problems = cleaned.ok ? violations : [`cleanup failed: ${cleaned.error instanceof Error ? cleaned.error.message : String(cleaned.error)}`, ...violations];
  if (problems.length) throw new Error(problems.join('\n'), cleaned.ok ? undefined : { cause: cleaned.error });
}
