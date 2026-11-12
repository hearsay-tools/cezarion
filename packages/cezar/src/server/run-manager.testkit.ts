import { RunManager } from '../workflows/run.ts';
import type { RunManagerFactory } from './project-context.ts';

/** The real manager factory `serve` passes, for tests that build a non-boot project context. */
export const createRunManager: RunManagerFactory = (...args) => new RunManager(...args);
