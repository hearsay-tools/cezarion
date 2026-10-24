# Preserve unknown fields in stored runs

Runtime validation drops fields outside its schema. Serializing only the parsed run would
therefore erase data written by another version. Keep unknown JSON beside the parsed record
and merge it back only where its known parent still exists.

## Consequences

Known edits and deletions take precedence. Arrays with distinct string ids match extras by
id through reorder, insertion and removal. Other arrays retain positional extras only while
their known content is unchanged. This preserves data without attaching an unknown field
to a different element. The codec remains independent of the run schema.

Implementation: [raw-record.ts](../../packages/cezar/src/runs/raw-record.ts), [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [raw-record.test.ts](../../packages/cezar/src/runs/raw-record.test.ts).
