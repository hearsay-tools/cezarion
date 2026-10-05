# Recover incomplete structured questions — issue hearsay-tools/cezarion#88

Approved by the user on 2026-09-05.

Append only missing closing brackets/braces to a complete JSON value. Refuse unterminated strings, mismatched delimiters, and comma/colon endings; parse again and apply the existing strict schema and bounded presentation normalization. Never invent missing options or selection semantics.

Both fresh and continuation turn handlers resolve questions and persistent notes through one helper. Recovered cards carry a danger note asking the user to check options and how many may be selected. Rejections also use danger notes. Old or unknown tones remain dim. Hide recovered markers only when the assembled turn holds a validated card; retain raw events to preserve rejected split-stream fallback.

Preserve DONE over ASK over monitoring precedence, Claude ScheduleWakeup detection/reset, and monitoring wake serialization. No timer, state transition, environment flag, dependency, package identity or version changes. Existing diagnostic rendering supplies light/dark styles; no new art or interaction.

Verification covers parser boundaries, both handlers, raw-marker removal, warning persistence/tone, existing harness and monitoring tests, and all five repository validation commands. Keep the PR draft.
