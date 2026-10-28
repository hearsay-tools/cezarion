# Backward compatibility

- Keep saved user data readable. Provide migrations when needed.
- Keep existing configuration, workflows and skills valid, or provide a conversion.
- Preserve documented commands and external interfaces. Explain intentional breaks and provide a migration path.
- Test these promises against old data and inputs.

## Root request completion (hearsay-tools/cezarion#1996)

Root done gains `requests_outstanding` and `requests_unanswered` refusal codes. Sent
requests block done and repeated done parks on a request wait without its own deadline.
Incoming requests refuse once, then completion settles them without reply. Human Finish
closes sent requests as `sender-closed`, including at review and after restart.

A provider failure after Finish retires its intent with the failure write, including a root
with no peer or conversation. Recovery rewrites an older stored root record only when its
status is `failed` and its delegation still has `finishRequestedAt`: it removes that field
and keeps the failure and other delegation fields. An older cezar reads the repaired record
with the same schema and no stale Finish blocker; it cannot recover the removed intent.
Continue remains available. No schema migration or new stored field is needed.
