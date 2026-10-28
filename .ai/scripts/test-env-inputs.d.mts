// The exports TypeScript imports from test-env-inputs.mjs.
export declare const TEST_ENV_INPUTS: string

export declare function readTestEnvInputs(root: string): {
  inputs: { version: 1; server: { env: string[] }; browser: { agentBrowserVersion: string } }
  sha256: string
}

export declare function testEnvInputsMismatch(root: string, descriptor: unknown): string | undefined

export declare function readTestEnvDescriptor(root: string): unknown

export declare function agentBrowserVersion(output: string): string
