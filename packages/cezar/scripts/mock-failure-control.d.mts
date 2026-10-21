export type NativeFailure = 'provider' | 'usage-limit' | 'unread';
export type FailureControlOptions = { mode: 'gated-once' }
  | { mode: 'persistent'; opening: string; failure: NativeFailure };
export function createFailureControl(root: string, options: FailureControlOptions): {
  path: string;
  held(): boolean;
  release(): void;
  lift(): void;
};
export function readFailureControl(supportedFailures?: readonly NativeFailure[]): {
  failure: NativeFailure;
  failureFor(text: string): NativeFailure | undefined | Promise<NativeFailure | undefined>;
};
