import { expect, it } from 'vitest';
import { workerExecutionSchema } from './worker-execution.ts';

const generation = 'b12898b9-8bf7-4c24-85e3-5ecf2b4d469e';
const retention = {
  generation, resourceId: 'ff04f7e5-25b8-4f57-9050-895fe33fc6e6', bootId: 'deffb118-419a-4586-af9e-748667bd30c8',
  roots: [{ path: '/owned', identity: { dev: '8:1', ino: '9007199254740993123' } }],
  processes: [{ pid: 42, start: '12345', identities: [{ dev: '8:1', ino: '9007199254740993123' }] }],
};

it('keeps older execution checkpoints readable and validates bounded retention identity', () => {
  expect(workerExecutionSchema.safeParse({ generation, phase: 'complete' }).success).toBe(true);
  expect(workerExecutionSchema.safeParse({ generation, phase: 'complete', aliasRetention: retention }).success).toBe(true);
  expect(workerExecutionSchema.safeParse({ generation, phase: 'complete', aliasRetention: { ...retention, generation: retention.resourceId } }).success).toBe(false);
  expect(workerExecutionSchema.safeParse({ generation, phase: 'complete', aliasRetention: { ...retention, processes: [] } }).success).toBe(false);
  expect(workerExecutionSchema.safeParse({ generation, phase: 'complete', aliasRetention: { ...retention, bootId: 'unknown' } }).success).toBe(false);
});
