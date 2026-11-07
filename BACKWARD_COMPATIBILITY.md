# Backward compatibility

- Keep saved user data readable. Provide migrations when needed.
- Keep existing configuration, workflows and skills valid, or provide a conversion. For example, a `skillsRepos` entry without `enabled` stays enabled.
- Preserve documented commands and external interfaces. Explain intentional breaks and provide a migration path.
- Test these promises against old data and inputs.

The staged home recovery reason `legacy-change` is additive. Current cockpit readers
drop unknown reasons and keep known rows. Already shipped strict readers cannot gain
that tolerance retroactively: the server emits this reason only with `REBRAND_SWITCH`
enabled, in the release that includes the tolerant reader. The existing reset and
outside-write rows and actions keep their formats and behavior.

The staged host CLI actions `cez backup import <file>` and `cez backup ignore
<file>` add legacy-change recovery without changing `list` or `restore`. They
refuse while `REBRAND_SWITCH` is disabled and appear in backup help only when
enabled. Grant files remain unavailable to cockpit mutations; the host CLI uses
the existing HomeFile allowlist and shared recovery writer.
