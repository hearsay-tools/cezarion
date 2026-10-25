// Fails a change that adds a bare issue or PR citation (hearsay-tools/cezarion#1310).
// AGENTS.md § Issue and PR citations requires `owner/repo#N`, because the fork and
// upstream trackers reuse numbers. Usage, from the repository root:
//
//   node .github/scripts/check-citations.cjs [--base <ref>]   (default origin/main)
//
// It compares HEAD with its merge-base against <ref>, so only committed changes count.
// It reads comments and test titles in JS/TS, comments in CSS, YAML and shell, and
// Markdown prose. String literals, code, JSX text and every other file type carry data
// (UI sample numbers, fixture titles, payloads), so it never reads them.
//
// A number N fails only when the changed files hold more bare #N after the change than
// before it, and the failure names each bare #N on an added line. Rewording, reflowing
// or moving a legacy citation therefore passes; legacy citations never set the style.
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const ZERO_SHA = /^0+$/;
const ARCHIVE_NOTE = /^> Historical source: /m;
// Generated from upstream commit titles (.ai/upstream/README.md), and test data.
const SKIPPED_PATH = /^\.ai\/upstream\/(?:LEDGER\.md$|scans\/)|(?:^|\/)(?:fixtures|__fixtures__|__snapshots__)\//;

// `#` and a number with no leading zero, which `#000` colors have. A following word
// character or `-` makes it a color or an anchor (`#12ab`, `#12-step`).
const CANDIDATE = /#([1-9]\d*)(?![\w-])/g;
// A `#` joined to a word, path, URL, entity or shell expansion is not a citation; this
// also covers `owner/repo#N` (`PR#12`, `file.md#12`, `&#8212;`, `$#`, `${#a}`, `\#12`).
const JOINED = /[\w$&{/.\\#@]/;
const FORK_OR_UPSTREAM = /\b(?:fork|upstream)\s+(?:(?:issue|PR|pull request)\s+)?$/i;
// Code spans, which hold test filters, sample values and shell; they do not cross a
// blank line. A Markdown link to a GitHub issue or PR qualifies the same number in its
// text, in any repository, so `[#46842](https://github.com/anomalyco/opencode/issues/46842)`
// passes and `[#12](https://github.com/o/r/issues/34)` does not.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const ISSUE_LINK = /\[([^\]\n]*)\]\(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)(?:[/#?][^)\s]*)?\)/g;
const TEST_FUNCTION = /^(?:describe\w*|it|test)$/;

const blank = (text) => text.replace(/[^\n]/g, ' ');
const qualifyLink = (link, text, number) =>
  `[${text.replace(new RegExp(`#${number}(?!\\d)`, 'g'), blank)}]${blank(link.slice(text.length + 2))}`;

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Comments and test titles, from @babel/parser (a root devDependency, as in check-code-quality). */
function scriptSpans(text, file) {
  const { parse } = require('@babel/parser');
  const plugins = [];
  if (/\.[cm]?tsx?$/.test(file)) plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(file) }]);
  if (/\.[jt]sx$/.test(file)) plugins.push('jsx');
  let ast;
  try {
    ast = parse(text, { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, attachComment: false, plugins });
  } catch (error) {
    throw new Error(`cannot parse ${file}, so its comments cannot be read: ${error.message}`);
  }
  const spans = ast.comments.map(({ start, end }) => ({ start, end, context: 'comment' }));
  const isTestCall = (callee) => {
    let node = callee;
    while (node.type === 'MemberExpression' || node.type === 'CallExpression') node = node.object ?? node.callee;
    return node.type === 'Identifier' && TEST_FUNCTION.test(node.name);
  };
  const title = (node) => {
    if (node?.type === 'StringLiteral') spans.push({ start: node.start, end: node.end, context: 'test title' });
    else if (node?.type === 'TemplateLiteral') for (const quasi of node.quasis) spans.push({ start: quasi.start, end: quasi.end, context: 'test title' });
    else if (node?.type === 'BinaryExpression' && node.operator === '+') [node.left, node.right].forEach(title);
  };
  const visit = (node) => {
    if (node.type === 'CallExpression' && isTestCall(node.callee)) title(node.arguments[0]);
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) if (typeof child?.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return spans;
}

function cssSpans(text) {
  const spans = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?(?:\*\/|$)/g)) {
    if (match[0].startsWith('/*')) spans.push({ start: match.index, end: match.index + match[0].length, context: 'comment' });
  }
  return spans;
}

/** `#` comments in YAML and shell. A shell quote opens anywhere (`pre' #12'`), a backslash
 *  escapes the next character, and a comment can start after a control operator (`cmd;#`).
 *  A YAML quote opens only at the start of a token, so the apostrophe in a plain value such
 *  as `the fork's rail` stays prose, and a YAML comment needs whitespace before it. */
function hashCommentSpans(text, file) {
  const shell = /\.(?:sh|bash)$/.test(file);
  const spans = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const before = i === 0 ? '\n' : text[i - 1];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = null;
    } else if (shell && char === '\\') {
      i++;
    } else if ((char === '"' || char === "'") && (shell || /[\s=:([{,]/.test(before))) {
      quote = char;
    } else if (char === '#' && (shell ? /[\s;&|()<>]/ : /\s/).test(before)) {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      // After the comment marker, so `#1310: …` as a whole comment is not read as a citation.
      spans.push({ start: i + 1, end, context: 'comment' });
      i = end;
    }
  }
  return spans;
}

/** Markdown outside fenced code blocks. */
function proseSpans(text) {
  const spans = [];
  let fence = null;
  let start = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
        start = offset + line.length + 1;
      }
    } else if (marker && !(marker[0] === '`' && line.slice(line.indexOf(marker) + marker.length).includes('`'))) {
      spans.push({ start, end: offset, context: 'Markdown prose' });
      fence = marker;
    }
    offset += line.length + 1;
  }
  if (!fence) spans.push({ start, end: text.length, context: 'Markdown prose' });
  return spans;
}

const READERS = [
  [/\.(?:[cm]?[jt]s|[jt]sx)$/, scriptSpans],
  [/\.css$/, cssSpans],
  [/\.(?:ya?ml|sh|bash)$/, hashCommentSpans],
  [/\.md$/, proseSpans],
];
const readerOf = (file) => READERS.find(([type]) => type.test(file))?.[1];

/** Every bare citation `file`'s text holds where it is read: `{ line, number, context }`. */
function bareCitations(file, text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const found = [];
  for (const { start, end, context } of readerOf(file)?.(text, file) ?? []) {
    const span = text.slice(start, end).replace(CODE_SPAN, blank).replace(ISSUE_LINK, qualifyLink);
    for (const match of span.matchAll(CANDIDATE)) {
      const before = span.slice(0, match.index);
      if (JOINED.test(before.at(-1) ?? ' ') || FORK_OR_UPSTREAM.test(before)) continue;
      found.push({ line: lineOf(starts, start + match.index), number: Number(match[1]), context });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

/** The new side's added line numbers, from a blob-to-blob diff: blobs have no path, so no attribute applies. */
function addedLines(git, oldSha, newSha) {
  const lines = new Set();
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', oldSha, newSha]);
  for (const [, from, count = '1'] of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let line = Number(from); line < Number(from) + Number(count); line++) lines.add(line);
  }
  return lines;
}

/** Resolves HEAD and its merge-base with `base` once; every later git call names only SHAs. */
function checkCitations({ cwd, base }) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  const head = git(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']).trim();
  const from = git(['merge-base', '--end-of-options', base, head]).trim();
  const fields = git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-color', '--no-relative', from, head]).split('\0');
  const counts = new Map();
  const count = (citations, sign) => {
    for (const { number } of citations) counts.set(number, (counts.get(number) ?? 0) + sign);
  };
  const candidates = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha] = fields[i].slice(1).split(' ');
    const file = fields[i + 1];
    if (SKIPPED_PATH.test(file) || !readerOf(file)) continue;
    const read = (mode, sha) => (/^100/.test(mode) && !ZERO_SHA.test(sha) ? git(['cat-file', 'blob', sha]) : null);
    const before = read(oldMode, oldSha);
    const after = read(newMode, newSha);
    // An archive keeps upstream's bare citations under its source note. A file this change
    // adds with the note is an import: its imported text and any new prose in it are one
    // added file, so it is skipped and a reviewer reads it. An existing file that gains
    // the note is checked as usual, where the count passes its legacy citations. An archive
    // that loses the note, or is deleted, keeps no baseline: its citations lost their
    // attribution, so every one left in the file, or moved into another, fails.
    const noteBefore = before !== null && ARCHIVE_NOTE.test(before);
    const noteLost = noteBefore && (after === null || !ARCHIVE_NOTE.test(after));
    if (before !== null && !noteLost) count(bareCitations(file, before), -1);
    if (after === null || (before === null && ARCHIVE_NOTE.test(after))) continue;
    const citations = bareCitations(file, after);
    count(citations, 1);
    if (citations.length === 0) continue;
    const added = before === null || noteLost ? null : addedLines(git, oldSha, newSha);
    for (const citation of citations) if (!added || added.has(citation.line)) candidates.push({ path: file, ...citation });
  }
  const findings = candidates.filter(({ number }) => counts.get(number) > 0);
  return { base: from, head, findings };
}

const message = ({ number, context }) =>
  `bare #${number} in a ${context}. Write hearsay-tools/cezarion#${number} (fork) or open-mercato/cezar#${number} (upstream).`;
const escapeData = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

function main(argv) {
  let result;
  try {
    const { values } = parseArgs({ args: argv, options: { base: { type: 'string', default: 'origin/main' } } });
    result = checkCitations({ cwd: process.cwd(), base: values.base });
  } catch (error) {
    process.stderr.write(`check-citations: ${String(error.stderr || error.message).trim()}\n`);
    return 2;
  }
  const since = `since ${result.base.slice(0, 12)}`;
  if (result.findings.length === 0) {
    process.stdout.write(`check-citations: no bare issue or PR citation added ${since}.\n`);
    return 0;
  }
  for (const finding of result.findings) {
    process.stdout.write(`${finding.path}:${finding.line}: ${message(finding)}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      process.stdout.write(`::error file=${escapeProperty(finding.path)},line=${finding.line},title=Bare issue citation::${escapeData(message(finding))}\n`);
    }
  }
  process.stdout.write(`check-citations: ${result.findings.length} bare issue or PR citation(s) added ${since}. `
    + 'Qualify each one (AGENTS.md § Issue and PR citations); a bare #N next to new code is legacy, not a style to copy.\n');
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { bareCitations, checkCitations };
