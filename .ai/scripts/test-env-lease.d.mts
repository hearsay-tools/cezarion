export declare function acquireTestEnvLease(root: string, options?: {
  token?: string;
  pid?: number;
  group?: boolean;
  timeoutMs?: number;
  onWait?: (message: string) => void;
}): Promise<{ token: string; release(): void }>;
