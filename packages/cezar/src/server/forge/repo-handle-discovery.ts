export const REPO_HANDLE_DISCOVERY_STATUSES = ['resolved', 'unknown', 'retryable', 'cancelled'] as const;
export type RepoHandleDiscoveryStatus = (typeof REPO_HANDLE_DISCOVERY_STATUSES)[number];

/** Internal discovery outcome: callers that own a lifecycle can retry only transient failures. */
export type RepoHandleDiscovery =
  | { status: Extract<RepoHandleDiscoveryStatus, 'resolved'>; handle: { owner: string; name: string } }
  | { status: Extract<RepoHandleDiscoveryStatus, 'unknown'> }
  | { status: Extract<RepoHandleDiscoveryStatus, 'retryable'> }
  | { status: Extract<RepoHandleDiscoveryStatus, 'cancelled'> };
