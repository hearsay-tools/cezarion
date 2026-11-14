const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INBOX } = require('./friction-policy.cjs');

const workflowPath = path.join(__dirname, '..', 'workflows', 'issue-intake.yml');
// The provider reads duplicate candidates through the code filter (#1163).
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

  const validator = job(workflow, 'validate-provider');
  assert.match(validator, /permissions: \{\}/);
  assert.match(validator, /case "\$ISSUE_INTAKE_PROVIDER" in/);
  assert.match(validator, /^ {12}jev\)/m);
  assert.match(validator, /ISSUE_INTAKE_PROVIDER must be set to jev/);
  assert.match(validator, /Unsupported ISSUE_INTAKE_PROVIDER/);
  assert.doesNotMatch(validator, /ANTHROPIC_API_KEY|OPENAI_API_KEY|TYPESAFE_API_KEY/);

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
  assert.ok(jev.indexOf('name: Fetch issue context') < jev.indexOf('name: Run Jev issue triage'));
  // A billable provider call: untrusted bots must not trigger it.
  assert.match(jev, /name: Reject untrusted bot actors/);
  assert.match(jev, /\[\[ "\$ACTOR" == \*'\[bot\]' && "\$ACTOR" != 'claude\[bot\]' \]\]/);
  assert.ok(jev.indexOf('name: Reject untrusted bot actors') < jev.indexOf('name: Run Jev issue triage'), 'bot guard must run before Jev');

  const apply = job(workflow, 'apply-intake');
  // No if: the default success() runs it only after jev-intake succeeded.
  assert.match(apply, /needs: jev-intake\n    runs-on:/);
  assert.match(apply, /permissions:\n      contents: read\n      issues: write/);
  assert.doesNotMatch(apply, /TYPESAFE_API_KEY/);
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
  assert.match(aggregate, /\[ "\$JEV_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /\[ "\$APPLY_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /needs: \[validate-provider, jev-intake, apply-intake\]/);
  assert.match(aggregate, /permissions: \{\}/);

  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  assert.equal((workflow.match(/secrets\.TYPESAFE_API_KEY/g) || []).length, 1, 'only the Jev job may read the TYPESAFE_API_KEY secret');
});

// The provider jobs need validate-provider, so skipping it skips them; the
// aggregate runs on always() and would fail on a skipped validator unless it
// skips too.
test('friction inbox issues skip every intake job, the aggregate included', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const skip = `!contains(github.event.issue.labels.*.name, '${INBOX.label}')`;
  assert.ok(job(workflow, 'validate-provider').includes(`\n    if: \${{ ${skip} }}\n`));
  assert.ok(job(workflow, 'issue-intake').includes(`\n    if: \${{ always() && ${skip} }}\n`));
  assert.match(job(workflow, 'jev-intake'), /needs: validate-provider\n/);
});

test('the intake provider receives label context without friction routing labels', () => {
  const yaml = require('yaml');
  const { execFileSync } = require('node:child_process');
  const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
  const fetch = workflow.jobs['jev-intake'].steps.find(s => s.name === 'Fetch issue context').run;
  const line = fetch.split('\n').find(line => line.includes('gh label list'));
  assert.ok(line);
  // Execute its actual jq expression, if any, on representative label data.
  const expression = line.match(/--jq '([^']+)'/)?.[1] ?? '.';
  const result = JSON.parse(execFileSync('jq', [expression], { input: JSON.stringify([
    { name: 'bug' }, { name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-knowledge' },
  ]), encoding: 'utf8' }));
  assert.deepEqual(result.map(l => l.name), ['bug']);
});
