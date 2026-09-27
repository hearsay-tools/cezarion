# Codex 0.155.1 reconnect loop (#550)

Source: the [real app-server probe recorded on #550](https://github.com/hearsay-tools/cezarion/issues/550#issuecomment-5823659240), 2026-09-24, with the CA unset.

These are the two fully spelled-out error payloads from that recording, wrapped
in JSON-RPC notification envelopes. The second preserves only fields present in
the report: no inferred codexErrorInfo, thread IDs or turn IDs. The abbreviated
5/5 frame and truncated transport warning are deliberately not reconstructed.
The observed timings were 0.7s and 9.9s, followed by the same network error at
18.1s, 31.2s and indefinitely. No terminal turn notification arrived.

The mock adds its own thread/turn IDs and repeats the final recorded payload to
exercise the real runner deadline. Those routing IDs and test timing are synthetic;
the error text and retry flags are recorded evidence, not generated expectations.
