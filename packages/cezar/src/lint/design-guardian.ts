import type { Finding, SourceRule } from './source-rule.ts';

interface SourceFile {
  /** Path relative to packages/web, always with `/` separators (allowlists match on it). */
  rel: string
  ext: string
  isTest: boolean
  isE2e: boolean
  /** Comment-stripped source; stripping preserves line numbers and column positions. */
  lines: string[]
}

interface Rule {
  name: string
  why: string
  pattern: RegExp
  applies: (file: SourceFile) => boolean
  /** Files where the token is legitimate (the token definition site, primitives). */
  allowed?: (rel: string) => boolean
}

/** Shipped UI code and stylesheets — where the design tokens are the only color vocabulary. */
const styleSources = (f: SourceFile) => !f.isTest && !f.isE2e
/** Everything that executes in or against the app, tests and e2e drivers included. */
const codeSources = (f: SourceFile) => f.ext !== '.css'

export const DESIGN_RULES: Rule[] = [
  {
    name: 'no-raw-hex-colors',
    why: 'colors go through the design tokens in src/styles/index.css, never raw hex',
    // 3/4/6/8-digit hex only (the CSS color grammar); the lookarounds reject HTML entities
    // (`&#8203;`) and longer hashes, and comment stripping removes issue refs like `#402`.
    pattern: /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g,
    applies: styleSources,
    // report-libraries.ts holds Tailwind v3's palette for agent-written report documents, not cockpit UI.
    allowed: (rel) => rel === 'src/styles/index.css' || rel === 'src/lib/report-libraries.ts',
  },
  {
    name: 'no-amber-text',
    why: 'amber ink goes through --pending-strong, the per-theme readable token; --pending itself is a dot & spinner FILL and fails contrast as text on the light theme (token sheet rule)',
    // `text-pending-strong` is excluded by the lookahead — it is the sanctioned spelling, and it
    // is a different token, not a loophole: `--pending` is amber-400 in both themes, while
    // `--pending-strong` darkens to amber-700 on light. Everything else amber stays banned.
    pattern: /\btext-(?:pending(?!-strong)|amber(?:-\d+)?)\b/g,
    applies: styleSources,
  },
  {
    name: 'no-color-named-or-ambiguous-brand-utilities',
    why: 'UI consumes action and accent roles, never the ambiguous primary or color-named violet utilities',
    pattern: /\b(?:accent|bg|border|text|ring)-(?:primary|violet)(?:-[\w-]+)?(?:\/(?:\[[^\]]+\]|[\w.-]+))?/g,
    applies: styleSources,
    // The token sheet's `--text-primary` means primary BODY TEXT, not a brand-color utility.
    allowed: (rel) => rel === 'src/styles/index.css',
  },
  {
    name: 'no-action-color-as-chrome',
    why: 'action is reserved for action fills; selection, focus, and other chrome use the accent token family',
    pattern: /\b(?:border-action(?!-foreground)|(?:selection:)?bg-action(?!-foreground))(?:\/(?:\[[^\]]+\]|[\w.-]+))?/g,
    applies: styleSources,
    // These are the deliberate gold surfaces: shared action buttons, the mobile create action,
    // the inline Save action, the confirmed task-commit View changes link action,
    // and decorative gold points in the sparse twinkle backdrop.
    allowed: (rel) =>
      rel === 'src/components/ui/button.tsx' ||
      rel === 'src/routes/tasks-overview.tsx' ||
      rel === 'src/routes/task-thread/thread-items.tsx' ||
      rel === 'src/routes/task-git/commit-list.tsx' ||
      rel === 'src/components/centered-state.tsx' ||
      rel === 'src/styles/index.css',
  },
  {
    name: 'no-fill-accent-as-ink',
    why: 'accent-strong is a fill and border role; readable labels use accent-text and icons use accent-icon',
    pattern: /(?:\btext-accent-strong(?!-foreground)\b|\btext-\[var\(--accent-strong\)\]|\[color:\s*var\(--accent-strong\)\]|(?<![-\w])color\s*:\s*['"]?var\(--accent-strong\))/g,
    applies: styleSources,
  },
  {
    name: 'no-raw-black-white',
    why: 'use surface/foreground tokens so both themes work; bg/text-white/black bypass them',
    pattern: /\b(?:bg|text)-(?:white|black)\b/g,
    applies: styleSources,
    // The shadcn overlay scrims (dialog, sheet) and the image lightbox scrim are deliberately
    // bg-black/xx in both themes — a dark backdrop is theme-agnostic by design.
    allowed: (rel) =>
      rel.startsWith('src/components/ui/') || rel === 'src/components/zoomable-image.tsx',
  },
  {
    name: 'no-native-dialogs',
    why: 'native confirm()/alert()/prompt() block the event loop and ignore the design system',
    // Bare or window./globalThis.-qualified calls; `foo.confirm(` (someone's API) stays legal.
    pattern: /(?<![\w$.])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g,
    applies: codeSources,
    // The bookmarklet generator's `alert(` lives inside the javascript: PROGRAM STRING it
    // emits (spec 011, ported verbatim from web/app.js). That program runs on github.com,
    // where the cockpit's toaster does not exist — alert() is its only honest surface. The
    // cockpit's own code in that file never calls a native dialog.
    allowed: (rel) => rel === 'src/lib/bookmarklet.ts',
  },
  {
    name: 'no-dark-variant',
    why: 'theming keys off the [data-theme] tokens, not prefers-color-scheme dark: variants',
    // `dark:` immediately followed by a utility (letter, `[`, `!`, `-`, `/`) — an object
    // literal's `dark: value` key has whitespace after the colon and stays legal.
    pattern: /\bdark:(?=[a-z![/-])/g,
    applies: styleSources,
  },
  {
    name: 'fixture-serve-must-pin-cez-home',
    why: "a spec-owned `hsq serve` takes its env from fixtureServeEnv(dataRoot) — a hand-rolled { CEZ_DRY_RUN } leaves CEZ_HOME at the developer's real ~/.cezar, so every run appends a dead /tmp fixture to their project registry",
    // Line-level: a CEZ_DRY_RUN that is not accompanied by a CEZ_HOME on the same line. Both
    // fixtureServeEnv() and the specs that spell the pair inline satisfy it.
    pattern: /^(?![^\n]*CEZ_HOME)[^\n]*\bCEZ_DRY_RUN\b/g,
    applies: (f) => f.isE2e,
  },
  {
    name: 'no-100vh',
    why: 'viewport height is 100dvh/h-dvh — 100vh ignores mobile browser chrome (iOS rule)',
    pattern: /\b(?:(?:h|min-h|max-h)-screen|100vh)\b/g,
    applies: styleSources,
  },
]

interface CommentScanner {
  out: string
  mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  i: number
}

function scanCode(state: CommentScanner, c: string, n: string | undefined, lineComments: boolean): void {
  if (lineComments && c === '/' && n === '/') {
    state.mode = 'line'
    state.out += '  '
    state.i += 2
    return
  }
  if (c === '/' && n === '*') {
    state.mode = 'block'
    state.out += '  '
    state.i += 2
    return
  }
  if (c === "'") state.mode = 'single'
  else if (c === '"') state.mode = 'double'
  else if (c === '`') state.mode = 'template'
  state.out += c
  state.i += 1
}

function scanComment(state: CommentScanner, c: string, n: string | undefined): void {
  if (state.mode === 'line') {
    if (c === '\n') {
      state.mode = 'code'
      state.out += c
    } else {
      state.out += ' '
    }
    state.i += 1
    return
  }
  if (state.mode === 'block') {
    if (c === '*' && n === '/') {
      state.mode = 'code'
      state.out += '  '
      state.i += 2
      return
    }
    state.out += c === '\n' ? c : ' '
    state.i += 1
  }
}

function scanString(state: CommentScanner, c: string, n: string | undefined): void {
  // String modes: honor escapes, close on the matching quote (or, for ' and ", a newline —
  // an unterminated string must not swallow the rest of the file).
  if (c === '\\') {
    state.out += c + (n ?? '')
    state.i += 2
    return
  }
  if (
    (state.mode === 'single' && (c === "'" || c === '\n')) ||
    (state.mode === 'double' && (c === '"' || c === '\n')) ||
    (state.mode === 'template' && c === '`')
  ) {
    state.mode = 'code'
  }
  state.out += c
  state.i += 1
}

/**
 * Blanks out comments while preserving the file's shape (every non-newline comment char
 * becomes a space). Tracks string state so comment openers inside literals are ignored.
 * Known limitation: regex literals are not lexed, so `/` pairs inside one can eat the rest
 * of a line — acceptable for a guardian (it can only under-report on that one line).
 */
export function stripComments(source: string, lineComments: boolean): string {
  const state: CommentScanner = { out: '', mode: 'code', i: 0 }
  while (state.i < source.length) {
    const c = source[state.i]!
    const n = source[state.i + 1]
    if (state.mode === 'code') scanCode(state, c, n, lineComments)
    else if (state.mode === 'line' || state.mode === 'block') scanComment(state, c, n)
    else scanString(state, c, n)
  }
  return state.out
}

/** Adapt only the path and source; keep the guardian's scope and line-based matching. */
export function guardianFile(file: string, source: string): SourceFile | undefined {
  const rel = file.replace(/^packages\/web\//, '');
  if (rel === file || !/^(src|e2e)\//.test(rel) || !/\.(ts|tsx|css)$/.test(rel) || rel.split('/').at(-1) === 'design-guardian.test.ts') return undefined;
  const ext = rel.slice(rel.lastIndexOf('.'));
  return { rel, ext, isTest: /\.test\.(?:ts|tsx)$/.test(rel), isE2e: rel.startsWith('e2e/'), lines: stripComments(source, ext !== '.css').split('\n') };
}

/** Original ten checks, shared by oxlint and the CSS runner. */
export function guardianFindings(file: string, source: string): Finding[] {
  const input = guardianFile(file, source);
  if (!input) return [];
  const findings: Finding[] = [];
  for (const rule of DESIGN_RULES) {
    if (!rule.applies(input) || rule.allowed?.(input.rel)) continue;
    input.lines.forEach((line, index) => {
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({ line: index + 1, column: match.index, message: `${rule.name} — ${rule.why}: ${match[0].trim()} → hearsay-tools/cezarion#2422` });
      }
    });
  }
  return findings;
}

export const designGuardian: SourceRule = {
  name: 'design-guardian',
  description: 'The cockpit design guardian per-file rules (hearsay-tools/cezarion#2422)',
  applies: (file) => guardianFile(file, '') !== undefined,
  check: guardianFindings,
};
