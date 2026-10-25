const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INBOX } = require('./friction-policy.cjs');

const workflowPath = path.join(__dirname, '..', 'workflows', 'issue-intake.yml');
const schemaPath = path.join(__dirname, '..', 'schemas', 'issue-intake.schema.json');
const promptPath = path.join(__dirname, '..', 'codex', 'prompts', 'issue-intake.md');

function assertCodexEnvironment(prompt) {
  assert.match(prompt, /read-only sandbox/i);
  assert.match(prompt, /`\/tmp`/);
  assert.match(prompt, /`\/var\/tmp`/);
  assert.match(prompt, /`\/usr\/tmp`/);
  assert.match(prompt, /unwritable/i);
  assert.match(prompt, /`pytest` and `uv`[\s\S]*exit 127/i);
  assert.match(prompt, /npm run <script>.*node_modules.*tsx: not found/is);
  assert.match(prompt, /python -m unittest.*No usable temporary directory/is);
  assert.match(prompt, /do not repeatedly probe.*python.*suite/is);
  assert.match(prompt, /node --test/);
  assert.match(prompt, /python 3\.12\.3.*node\s+v24\.19\.0.*npm 11\.17\.0/is);
  assert.match(prompt, /git.*rg.*sed.*nl.*jq.*find.*yamllint.*python -c.*compile/is);
}

// Every provider reads duplicate candidates through the code filter (#1163).
function assertFilteredFetch(source) {
  assert.match(source, /name: Fetch issue context/);
  assert.match(source, /gh api --paginate/);
  assert.match(source, /\{number,title,body,labels,updated_at\}/);
  assert.match(source, /node \.github\/scripts\/issue-intake-candidates\.cjs \.issue-intake-context\/issue\.json "\$RUNNER_TEMP\/open-issues\.raw\.json"[\s\\]*> \.issue-intake-context\/open-issues\.json/);
}

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

test('issue intake workflow keeps its provider, permission, and fail-closed contract', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(workflow, /^name: Issue Intake$/m);
  assert.match(workflow, /issues:\n    types: \[opened\]/);
  assert.match(workflow, /ISSUE_INTAKE_PROVIDER: \$\{\{ vars\.ISSUE_INTAKE_PROVIDER \}\}/);
  assert.match(workflow, /openai\/codex-action@[0-9a-f]{40} {2}# v[0-9.]+\n/, 'codex-action must be pinned to a commit SHA, not a floating tag (openai/codex-action#150)');
  assert.match(workflow, /sandbox: read-only/);

  const validator = job(workflow, 'validate-provider');
  assert.match(validator, /permissions: \{\}/);
  assert.match(validator, /case "\$ISSUE_INTAKE_PROVIDER" in/);
  assert.match(validator, /claude\|codex\|jev\)/);
  assert.match(validator, /ISSUE_INTAKE_PROVIDER must be set to claude, codex or jev/);
  assert.match(validator, /Unsupported ISSUE_INTAKE_PROVIDER/);
  assert.doesNotMatch(validator, /ANTHROPIC_API_KEY|OPENAI_API_KEY|TYPESAFE_API_KEY/);

  const claude = job(workflow, 'claude-intake');
  assert.match(claude, /needs: validate-provider/);
  assert.match(claude, /if: needs\.validate-provider\.outputs\.provider == 'claude'/);
  assert.match(claude, /permissions:\n      contents: read\n      issues: write\n      id-token: write/);
  assert.match(claude, /anthropics\/claude-code-action@[0-9a-f]{40}/);
  assert.match(claude, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  // Public-repo default: inline prompt, no private marketplace plugin.
  assert.doesNotMatch(claude, /plugin_marketplaces:/);
  assert.doesNotMatch(claude, /plugins:/);
  assert.match(claude, /Triage newly opened issue/);
  assert.match(claude, /Bash\(gh issue close \$\{.*github\.event\.issue\.number \}\}:\*\)/);
  assert.match(claude, /Bash\(gh issue edit \$\{.*github\.event\.issue\.number \}\}:\*\)/);
  assert.doesNotMatch(claude, /Bash\(gh label/);
  // Duplicate candidates come only from the filtered, prefetched list.
  assert.doesNotMatch(claude, /Bash\(gh issue list|Bash\(gh search issues|Bash\(gh issue view:\*\)/);
  assertFilteredFetch(claude);
  assert.match(claude, /only duplicate candidates[\s\S]*\.issue-intake-context\/open-issues\.json/);
  assert.ok(claude.indexOf('name: Fetch issue context') < claude.indexOf('anthropics/claude-code-action@'), 'candidates exist before Claude runs');
  assert.doesNotMatch(claude, /Bash\(gh issue comment/);
  assert.doesNotMatch(claude, /OPENAI_API_KEY/);
  assert.doesNotMatch(claude, /vars\.ISSUE_INTAKE_CODEX_/);

  const codex = job(workflow, 'codex-intake');
  assert.match(codex, /needs: validate-provider/);
  assert.match(codex, /if: needs\.validate-provider\.outputs\.provider == 'codex'/);
  assert.match(codex, /permissions:\n      contents: read\n      issues: read/);
  assert.doesNotMatch(codex, /issues: write/);
  assert.doesNotMatch(codex, /id-token: write/);
  assert.match(codex, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.doesNotMatch(codex, /ANTHROPIC_API_KEY/);
  assert.match(codex, /prompt-file: .*\.github\/codex\/prompts\/issue-intake\.md/);
  assert.match(codex, /output-schema-file: .*\.github\/schemas\/issue-intake\.schema\.json/);
  assertFilteredFetch(codex);
  assert.doesNotMatch(codex, /--limit 50/);
  assert.match(codex, /name: Reject untrusted bot actors/);
  assert.match(codex, /\[\[ "\$ACTOR" == \*'\[bot\]' && "\$ACTOR" != 'claude\[bot\]' \]\]/);
  assert.ok(codex.indexOf('name: Reject untrusted bot actors') < codex.indexOf('openai/codex-action@'), 'bot guard must run before Codex');
  assert.match(codex, /allow-users: '\*'/);
  assert.match(codex, /allow-bot-users: 'claude\[bot\]'/);
  assert.doesNotMatch(codex, /allow-bots: true/);
  assert.doesNotMatch(job(workflow, 'claude-intake'), /Reject untrusted bot actors/);
  assert.doesNotMatch(codex, /vars\.ISSUE_INTAKE_CLAUDE_/);

  const jev = job(workflow, 'jev-intake');
  assert.match(jev, /needs: validate-provider/);
  assert.match(jev, /if: needs\.validate-provider\.outputs\.provider == 'jev'/);
  assert.match(jev, /permissions:\n      contents: read\n      issues: read\n\n/);
  assert.doesNotMatch(jev, /issues: write|id-token: write/);
  assert.match(jev, /persist-credentials: false/);
  assertFilteredFetch(jev);
  assert.match(jev, /TYPESAFE_API_KEY: \$\{\{ secrets\.TYPESAFE_API_KEY \}\}/);
  assert.match(jev, /ISSUE_INTAKE_JEV_MODEL: \$\{\{ vars\.ISSUE_INTAKE_JEV_MODEL \}\}/);
  assert.match(jev, /node \.github\/scripts\/jev-issue-intake\.cjs \.issue-intake-context intake-output\/intake\.json/);
  assert.match(jev, /name: intake-output\n\s+path: intake-output\/intake\.json\n\s+if-no-files-found: error/);
  assert.doesNotMatch(jev, /ANTHROPIC_API_KEY|OPENAI_API_KEY|vars\.ISSUE_INTAKE_(?:CLAUDE|CODEX)_/);
  assert.ok(jev.indexOf('name: Fetch issue context') < jev.indexOf('name: Run Jev issue triage'));
  // A billable provider call: untrusted bots must not trigger it.
  assert.match(jev, /name: Reject untrusted bot actors/);
  assert.match(jev, /\[\[ "\$ACTOR" == \*'\[bot\]' && "\$ACTOR" != 'claude\[bot\]' \]\]/);
  assert.ok(jev.indexOf('name: Reject untrusted bot actors') < jev.indexOf('name: Run Jev issue triage'), 'bot guard must run before Jev');

  const apply = job(workflow, 'apply-intake');
  assert.match(apply, /needs: \[validate-provider, codex-intake, jev-intake\]/);
  assert.match(apply, /provider == 'codex' && needs\.codex-intake\.result == 'success'/);
  assert.match(apply, /provider == 'jev' && needs\.jev-intake\.result == 'success'/);
  assert.match(apply, /permissions:\n      contents: read\n      issues: write/);
  assert.doesNotMatch(apply, /ANTHROPIC_API_KEY|OPENAI_API_KEY|TYPESAFE_API_KEY/);
  assert.match(apply, /require\('\.\/\.github\/scripts\/apply-issue-intake\.cjs'\)/);
  assert.match(apply, /require\('\.\/\.github\/scripts\/issue-intake-candidates\.cjs'\)/);
  assert.match(apply, /buildCandidates\(\{.*max: Infinity \}\)/);
  assert.match(apply, /planIntakeMutations\(\{[^}]*candidateNumbers/);
  assert.match(apply, /github\.event\.issue\.number/);

  const aggregate = job(workflow, 'issue-intake');
  // always() keeps the aggregate running after a failed or skipped provider
  // path, so that path fails the run. Its one exception, inbox issues, is
  // pinned in its own test below.
  assert.match(aggregate, /if: \$\{\{ always\(\) && [^\n]+ \}\}\n/);
  assert.match(aggregate, /\[ "\$VALIDATE_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$CLAUDE_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$CODEX_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$APPLY_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /needs: \[validate-provider, claude-intake, codex-intake, jev-intake, apply-intake\]/);
  assert.match(aggregate, /jev\)\n\s+\[ "\$JEV_RESULT" = 'success' \] \|\| exit 1\n\s+\[ "\$APPLY_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /permissions: \{\}/);

  assert.equal((workflow.match(/ANTHROPIC_API_KEY/g) || []).length, 1, 'only the Claude job may reference ANTHROPIC_API_KEY');
  assert.equal((workflow.match(/OPENAI_API_KEY/g) || []).length, 1, 'only the Codex job may reference OPENAI_API_KEY');
  assert.equal((workflow.match(/secrets\.TYPESAFE_API_KEY/g) || []).length, 1, 'only the Jev job may read the TYPESAFE_API_KEY secret');
  assert.ok(fs.existsSync(schemaPath), 'Codex intake schema must exist');
  assertCodexEnvironment(fs.readFileSync(promptPath, 'utf8'));
});

// The provider jobs need validate-provider, so skipping it skips them; the
// aggregate runs on always() and would fail on a skipped validator unless it
// skips too.
test('friction inbox issues skip every intake job, the aggregate included', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const skip = `!contains(github.event.issue.labels.*.name, '${INBOX.label}')`;
  assert.ok(job(workflow, 'validate-provider').includes(`\n    if: \${{ ${skip} }}\n`));
  assert.ok(job(workflow, 'issue-intake').includes(`\n    if: \${{ always() && ${skip} }}\n`));
  for (const name of ['claude-intake', 'codex-intake', 'jev-intake']) assert.match(job(workflow, name), /needs: validate-provider\n/);
});

test('each issue-intake provider interpolates only its own model and effort variables', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const claude = job(workflow, 'claude-intake');
  const codex = job(workflow, 'codex-intake');

  assert.match(claude, /--model \$\{.*vars\.ISSUE_INTAKE_CLAUDE_MODEL \|\| 'sonnet'/);
  assert.match(
    claude,
    /vars\.ISSUE_INTAKE_CLAUDE_EFFORT && format\('--effort \{0\}', vars\.ISSUE_INTAKE_CLAUDE_EFFORT\) \|\| ''/,
  );
  assert.doesNotMatch(claude, /^\s*--effort\s+\S/m, 'Claude --effort is omitted unless ISSUE_INTAKE_CLAUDE_EFFORT is set');

  assert.match(codex, /model: \$\{.*vars\.ISSUE_INTAKE_CODEX_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(codex, /effort: \$\{.*vars\.ISSUE_INTAKE_CODEX_EFFORT \|\| 'max'/);
});

test('all ordinary intake providers receive label context without friction routing labels', () => {
  const yaml = require('yaml');
  const { execFileSync } = require('node:child_process');
  const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
  for (const name of ['claude-intake', 'codex-intake', 'jev-intake']) {
    const fetch = workflow.jobs[name].steps.find(s => s.name === 'Fetch issue context').run;
    const line = fetch.split('\n').find(line => line.includes('gh label list'));
    assert.ok(line);
    // Execute its actual jq expression, if any, on representative label data.
    const expression = line.match(/--jq '([^']+)'/)?.[1] ?? '.';
    const result = JSON.parse(execFileSync('jq', [expression], { input: JSON.stringify([
      { name: 'bug' }, { name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-knowledge' },
    ]), encoding: 'utf8' }));
    assert.deepEqual(result.map(l => l.name), ['bug'], name);
  }
});
