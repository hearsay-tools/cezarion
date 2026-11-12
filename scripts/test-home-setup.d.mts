export interface TestHomeOptions {
  userHome: string;
  squawkHome?: string;
  keepHostHome?: boolean;
}
export function configureTestHome(options: TestHomeOptions, env?: NodeJS.ProcessEnv): {
  select(root: string | undefined): void;
  pinHome(): void;
  pinUserHome(): void;
};
