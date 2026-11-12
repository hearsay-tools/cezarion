export function stall(prompt: string, options?: { closeInput?: () => void }): boolean;
export function waitForRelease(fallbackMs?: number, suffix?: string): Promise<void>;
