# Treat skills as shared content and provision task-owned copies

Skills are playbooks, not account identity. Global discovery follows the user’s shared skill
library rather than a selected account home. Resolve collisions local-first. Missing sources
produce a smaller catalog; remote loading runs behind an in-process cache instead of blocking
catalog reads.

## Consequences

Picker curation controls default-source visibility, not whether a selected skill can use its
companions. Provision selected roots and the catalog skills their bodies name into the run’s
own worktree. The companion scan is a bounded heuristic, not a guarantee that every dependency
was discovered. Runs without an owned worktree retain a cache fallback.

Never overwrite unowned content or copy managed skills into the main checkout. Record owned
entries in the worktree Git directory and install ignore rules before files, so a crash cannot
leave new generated content eligible for autosave. Resolve destination links before writing.
Remote Git sources use explicit transport restrictions and noninteractive commands.

Remote listings resolve one immutable commit so bodies and companion files stay consistent across
concurrent fetches. Full-SHA sources never fall back to a moving ref. File-cache copies are
commit-keyed and staged before rename; passive fetch stamps are shared across processes.

## Considered Options

- **Follow each account home for global skills.** Rejected because changing a login should not select another playbook library.
- **Materialize managed skills in the main checkout.** Rejected because discovery would later treat those copies as higher-priority local content.

Implementation: [skills.ts](../../packages/cezar/src/skills.ts), [skills-provision.ts](../../packages/cezar/src/skills-provision.ts), [skills-remote.ts](../../packages/cezar/src/skills-remote.ts).

Coverage: [skills.test.ts](../../packages/cezar/src/skills.test.ts), [skills-provision.test.ts](../../packages/cezar/src/skills-provision.test.ts), [skills-remote.test.ts](../../packages/cezar/src/skills-remote.test.ts).
