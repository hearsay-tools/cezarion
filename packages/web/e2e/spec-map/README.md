# Replay a manual spec-map capture

Only `workflow_dispatch` runs publish `e2e-spec-map-replay-1` and `-2`.
They expire after one day. Each compressed archive contains an explicit allowlist:
V8 logs and expected-report markers, the results JSON, source maps, and served
compiled JavaScript/maps. It excludes the environment, test-env descriptor,
process-control manifests, application state and HOME.

Download both archives. Check out their captured commit in a fresh checkout.
Run the final mapper from the development checkout, with that fresh checkout as
`--repo` (its generated build paths must not exist):

```sh
node packages/web/e2e/spec-map/replay.ts rebuild \
  --archive /path/capture-1.jsonl.gz --archive /path/capture-2.jsonl.gz \
  --repo /path/fresh-checkout --out /path/e2e-spec-map.json
```

The replay relocates source-map and V8 paths, checks served bundle bytes, and runs
the same partial/merge validation as the workflow. Both shards must name one
commit and contain identical shared compiled files. A failed spec remains
incomplete. The archive does not include repository sources; use the recorded
commit's checkout for the module graph and mock scripts.
