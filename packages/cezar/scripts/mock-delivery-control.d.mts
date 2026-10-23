export type DeliveryControlOptions =
  | { kind: 'reject'; match: string; persistent?: boolean }
  | { kind: 'hold-ack'; match: string }
  | { kind: 'hold-response'; match: string };
export type DeliveryKind = DeliveryControlOptions['kind'];
export function createDeliveryControl(root: string, options: DeliveryControlOptions): {
  path: string;
  held(): boolean;
  release(): void;
  lift(): void;
};
/** Throws on a malformed control. A kind outside `supportedKinds` makes the mock exit with
 *  an error naming the variable when an input matches, before it answers that input. */
export function readDeliveryControl(supportedKinds: readonly DeliveryKind[]): {
  kind: DeliveryKind;
  /** True when this input must be rejected now; a non-persistent rule claims once across processes. */
  rejects(text: string): boolean;
  /** Sends the acknowledgement now, or after release for a matching hold-ack, without blocking the caller. */
  ack(text: string, send: () => void): void;
  /** Undefined when nothing is held; for a matching hold-response, a promise that resolves on release.
   *  A synchronous answer lets a mock that cannot await decide at once whether to buffer. */
  holdResponse(text: string): Promise<void> | undefined;
};
