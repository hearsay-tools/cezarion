# Backward compatibility

- Keep saved user data readable. Provide migrations when needed.
- Keep existing configuration, workflows and skills valid, or provide a conversion. For example, a `skillsRepos` entry without `enabled` stays enabled.
- Preserve documented commands and external interfaces. Explain intentional breaks and provide a migration path.
- Test these promises against old data and inputs.
