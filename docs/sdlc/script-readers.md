# Script readers

Scripts that interpret YAML structure or comments must use the root `yaml`
package's syntax tree, not line regexes. For comments and source offsets, use
its concrete syntax tree (`new Parser().parse(text)`). This keeps comments
separate from scalar content, including `#` lines inside block scalars.

Before implementation starts, a plan that introduces a hand-written shell or
Markdown reader must list the edge cases it handles and those it excludes.

These rules govern new readers. Migrating the existing YAML reader in
`.github/scripts/check-citations.cjs` is outside this change's scope
(hearsay-tools/cezarion#1726).
