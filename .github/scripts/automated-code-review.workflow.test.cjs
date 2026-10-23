const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflowPath = path.join(__dirname, '..', 'workflows', 'automated-code-review.yml');
const ciPath = path.join(__dirname, '..', 'workflows', 'ci.yml');
const legacyWorkflowPath = path.join(__dirname, '..', 'workflows', 'claude-code-review.yml');
const schemaPath = path.join(__dirname, '..', 'schemas', 'review-findings.schema.json');
const promptPath = path.join(__dirname, '..', 'codex', 'prompts', 'review.md');
const agentsPath = path.join(__dirname, '..', '..', 'AGENTS.md');

test('Codex receives resolved review metadata for PR and manual triggers', async (t) => {
  const { parse } = await import('yaml');
  const { execFileSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const round = workflow.jobs['review-round'].steps.find((step) => step.id === 'review-round');
  const context = workflow.jobs['codex-review'].steps.find((step) => step.name === 'Fetch prior automated review context');
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  for (const event of ['pull_request_target', 'workflow_dispatch']) {
    await t.test(event, () => {
      const cwd = fs.mkdtempSync(path.join(tmpdir(), 'review-metadata-'));
      try {
        fs.mkdirSync(path.join(cwd, 'pull-request'));
        const output = path.join(cwd, 'outputs');
        const env = { ...process.env, BASH_ENV: '/dev/null', GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/repo',
          PR_NUMBER: '220', EVENT_NAME: event, AUTOMATED_REVIEW_ROUNDS: '3',
          EVENT_HEAD_SHA: event === 'workflow_dispatch' ? '' : head,
          EVENT_BASE_SHA: event === 'workflow_dispatch' ? '' : base };
        // Only the GitHub transport is stubbed; execute the workflow's real resolution and writer.
        execFileSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c',
          `gh() { case "$*" in *'.head.sha'*) echo '${head}';; *'.base.sha'*) echo '${base}';; esac; }\n${round.run}`], { cwd, env });
        const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map((line) => line.split('=')));
        const contextEnv = { ...process.env, BASH_ENV: '/dev/null', GITHUB_REPOSITORY: 'owner/repo' };
        for (const [key, value] of Object.entries(context.env)) {
          const match = value.match(/^\$\{\{ needs\.review-round\.outputs\.(\w+) \}\}$/);
          if (match) contextEnv[key] = outputs[match[1]];
        }
        execFileSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', `gh() { :; }\n${context.run}`], { cwd, env: contextEnv });
        const metadataPath = path.join(cwd, 'pull-request/.review-context/pull-request.json');
        assert.ok(fs.existsSync(metadataPath), 'review must receive resolved metadata independently of the event payload');
        assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), { pr_number: 220, head_sha: head, base_sha: base });
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
  const prompt = fs.readFileSync(promptPath, 'utf8');
  assert.match(prompt, /\.review-context\/pull-request\.json/);
  assert.doesNotMatch(prompt, /Read `\$GITHUB_EVENT_PATH`/);
});

test('review-round classifies from trusted base before merge checkout and skips only docs-only and infra-only PRs', async (t) => {
  const { parse } = await import('yaml');
  const { execFileSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const roundJob = workflow.jobs['review-round'];
  const steps = roundJob.steps;
  const trustedCheckoutIndex = steps.findIndex((step) => step.with?.path === '.cez-trusted');
  const classifier = steps.find((step) => step.id === 'change-surface');
  const classifierIndex = steps.indexOf(classifier);
  const mergeCheckoutIndex = steps.findIndex((step) => step.with?.ref?.includes('refs/pull/'));
  const round = steps.find((step) => step.id === 'review-round');

  assert.ok(trustedCheckoutIndex >= 0, 'review-round must check out a trusted classifier');
  assert.equal(steps[trustedCheckoutIndex].with.ref, '${{ github.event.pull_request.base.sha || github.sha }}');
  assert.equal(steps[trustedCheckoutIndex].with['persist-credentials'], false);
  assert.ok(classifier, 'review-round must classify the change surface');
  assert.ok(trustedCheckoutIndex < classifierIndex, 'the classifier must come from the trusted checkout');
  assert.ok(classifierIndex < mergeCheckoutIndex, 'classification must run before the PR merge checkout');
  assert.match(classifier.run, /gh api --paginate --slurp/);
  assert.match(classifier.run, /changed_files/);
  assert.match(classifier.run, /previous_filename/);
  assert.match(classifier.run, /change-surface\.cjs/);
  assert.match(classifier.run, /full-matrix/);
  assert.match(classifier.run, /docs-only\|infra-only\|full-matrix/);
  assert.match(round.env.CHANGE_SURFACE, /steps\.change-surface\.outputs\.change_surface/);
  assert.equal(roundJob.outputs.change_surface, '${{ steps.review-round.outputs.change_surface }}');
  assert.match(round.run, /docs-only\|infra-only\|full-matrix/);
  assert.match(round.run, /\[ "\$EVENT_NAME" = pull_request_target \] && \{ \[ "\$change_surface" = docs-only \] \|\| \[ "\$change_surface" = infra-only \]; \};/);
  assert.match(round.run, /can_review=false/);

  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);

  function outputsAt(output) {
    return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  }

  function runScript(script, cwd, env) {
    execFileSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', script], { cwd, env });
  }

  function runRound({ event, files = [], apiFailure = false, classifierFailure = false }) {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'review-change-surface-'));
    try {
      const trustedPath = path.join(cwd, '.cez-trusted', '.github', 'scripts');
      fs.mkdirSync(trustedPath, { recursive: true });
      if (!classifierFailure) {
        fs.copyFileSync(path.join(__dirname, 'change-surface.cjs'), path.join(trustedPath, 'change-surface.cjs'));
      }
      const classifyOutput = path.join(cwd, 'classify-outputs');
      const roundOutput = path.join(cwd, 'round-outputs');
      const filesJsonLines = files.map((file) => JSON.stringify(file)).join('\n');
      const filePages = JSON.stringify([files.map((filename) => ({ filename }))]);
      const env = {
        ...process.env,
        BASH_ENV: '/dev/null',
        GITHUB_OUTPUT: classifyOutput,
        GITHUB_WORKSPACE: cwd,
        GITHUB_REPOSITORY: 'owner/repo',
        PR_NUMBER: '220',
        EVENT_NAME: event,
        EVENT_HEAD_SHA: event === 'workflow_dispatch' ? '' : head,
        EVENT_BASE_SHA: event === 'workflow_dispatch' ? '' : base,
        AUTOMATED_REVIEW_ROUNDS: '3',
        PR_FILES_JSONL: filesJsonLines,
      };
      const gh = apiFailure
        ? `gh() {
  case "$*" in
    *'/files'*) echo 'GitHub API unavailable' >&2; return 1 ;;
    *'/reviews'*) : ;;
    *'.head.sha'*) echo '${head}' ;;
    *'.base.sha'*) echo '${base}' ;;
  esac
}`
        : `gh() {
  case "$*" in
    *'changed_files'*) printf '%s\\n' '${files.length}' ;;
    *'map(.[]) | length'*) printf '%s\\n' '${files.length}' ;;
    *'.head.sha'*) echo '${head}' ;;
    *'.base.sha'*) echo '${base}' ;;
    *'/files'*) printf '%s\\n' '${filePages}' ;;
    *'/reviews'*) : ;;
  esac
}`;
      runScript(`${gh}\n${classifier.run}`, cwd, env);
      const changeSurface = outputsAt(classifyOutput).change_surface;
      assert.ok(changeSurface, 'classifier must publish change_surface');

      const roundEnv = {
        ...env,
        GITHUB_OUTPUT: roundOutput,
        CHANGE_SURFACE: changeSurface,
      };
      runScript(`${gh}\n${round.run}`, cwd, roundEnv);
      return outputsAt(roundOutput);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  await t.test('docs-only PRs skip review without a patch id', () => {
    const outputs = runRound({ event: 'pull_request_target', files: ['README.md', 'docs/guide.md'] });
    assert.equal(outputs.change_surface, 'docs-only');
    assert.equal(outputs.can_review, 'false');
    assert.equal(outputs.patch_id, '');
  });

  await t.test('infra-only PRs skip review without a patch id', () => {
    const outputs = runRound({ event: 'pull_request_target', files: ['.github/workflows/sweep-ci-failures.yml', '.github/scripts/ci-sweep-collect.cjs'] });
    assert.equal(outputs.change_surface, 'infra-only');
    assert.equal(outputs.can_review, 'false');
    assert.equal(outputs.patch_id, '');
  });

  await t.test('mixed PRs retain full-matrix review behavior', () => {
    const outputs = runRound({ event: 'pull_request_target', files: ['README.md', 'packages/cezar/src/index.ts'] });
    assert.equal(outputs.change_surface, 'full-matrix');
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('manual dispatch is always full-matrix and does not list files', () => {
    const outputs = runRound({ event: 'workflow_dispatch', files: ['README.md'] });
    assert.equal(outputs.change_surface, 'full-matrix');
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('API and trusted-classifier failures fail open to full-matrix', () => {
    assert.equal(runRound({ event: 'pull_request_target', files: ['README.md'], apiFailure: true }).change_surface, 'full-matrix');
    assert.equal(runRound({ event: 'pull_request_target', files: ['README.md'], classifierFailure: true }).change_surface, 'full-matrix');
  });
});

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

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `expected ${name} job`);
  return match[0];
}

test('automated review workflow keeps its round cap, provider, permission, and completion contract', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.equal(fs.existsSync(legacyWorkflowPath), false, 'the legacy independent Claude review workflow must not run beside the selector');
  assert.match(workflow, /^name: Automated Code Review$/m);
  assert.match(workflow, /concurrency:\n  group: automated-code-review-\$\{\{ github\.event_name \}\}-pr-\$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_number \}\}\n  cancel-in-progress: true/);
  assert.match(workflow, /AUTOMATED_REVIEWER: \$\{\{ vars\.AUTOMATED_REVIEWER \}\}/);
  assert.match(workflow, /openai\/codex-action@[0-9a-f]{40} {2}# v[0-9.]+\n/, 'codex-action must be pinned to a commit SHA, not a floating tag (openai/codex-action#150)');
  assert.match(workflow, /sandbox: read-only/);
  assert.match(fs.readFileSync(agentsPath, 'utf8'), /Automated reviewer \| `AUTOMATED_REVIEWER=codex`/);

  const round = job(workflow, 'review-round');
  assert.match(round, /permissions:\n      pull-requests: read/);
  assert.doesNotMatch(round, /pull-requests: write/);
  assert.match(round, /outputs:\n      can_review: \$\{\{ steps\.review-round\.outputs\.can_review \}\}/);
  assert.match(round, /pr_number: \$\{\{ steps\.review-round\.outputs\.pr_number \}\}/);
  assert.match(round, /head_sha: \$\{\{ steps\.review-round\.outputs\.head_sha \}\}/);
  assert.match(round, /base_sha: \$\{\{ steps\.review-round\.outputs\.base_sha \}\}/);
  assert.match(round, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(round, /gh api --paginate "\/repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/reviews" --jq '[^\n]*' \| wc -l/);
  const classifier = job(workflow, 'review-round').match(/- name: Classify pull request change surface[\s\S]*?(?=\n      - name:|\n      - id:)/)?.[0] || '';
  assert.doesNotMatch(classifier, /--slurp[\s\S]*--jq/, 'gh api does not support combining --slurp with --jq');
  assert.match(round, /select\(\.user\.login == "github-actions\[bot\]"\)/);
  assert.match(round, /select\(\.submitted_at != null\)/, 'pending bot reviews must not exhaust the cap');
  assert.match(round, /can_review=true/);
  assert.match(round, /can_review=false/);

  const claude = job(workflow, 'claude-review');
  assert.match(claude, /needs: \[validate-provider, review-round\]\n/);
  assert.match(claude, /needs\.review-round\.outputs\.can_review == 'true'/);
  assert.match(claude, /permissions:\n      actions: read\n      contents: read/);
  assert.match(claude, /pull-requests: read/);
  assert.doesNotMatch(claude, /pull-requests: write/);
  assert.match(claude, /github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(claude, /id-token: write/, 'the Claude job authenticates with GITHUB_TOKEN, not the OIDC app-token exchange, which rejects pull_request_target tokens');
  assert.match(claude, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.equal((workflow.match(/secrets\.ANTHROPIC_API_KEY/g) || []).length, 1, 'only the Claude job may reference ANTHROPIC_API_KEY');
  assert.equal((workflow.match(/secrets\.GITHUB_TOKEN/g) || []).length, 8, 'validate-provider bump classify, read-only round guard, and provider context fetches use secrets.GITHUB_TOKEN');
  assert.match(claude, /anthropics\/claude-code-action@[0-9a-f]{40}/);
  assert.match(claude, /ref: refs\/pull\/\$\{\{ needs\.review-round\.outputs\.pr_number \}\}\/merge/);
  assert.match(claude, /fetch-depth: 0/);
  assert.match(claude, /persist-credentials: false/);
  assert.match(claude, /name: Verify Claude can read pull request data/);
  assert.match(claude, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(claude, /gh pr view "\$PR_NUMBER" --repo "\$GITHUB_REPOSITORY" --json headRefOid,state/);
  assert.match(claude, /name: Fetch prior automated review context/);
  assert.match(claude, /gh api --paginate "\/repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/reviews" --jq '\.\[\]' > \.review-context\/prior-review-bodies\.jsonl/);
  assert.match(claude, /gh api --paginate "\/repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/comments" --jq '\.\[\]' > \.review-context\/prior-inline-comments\.jsonl/);
  assert.match(claude, /\.review-context\/prior-review-bodies\.jsonl/);
  assert.match(claude, /\.review-context\/prior-inline-comments\.jsonl/);
  assert.match(claude, /each\s+earlier actionable\s+finding/i);
  assert.match(claude, /one prior_findings\s+entry/i);
  assert.match(claude, /addressed or\s+remains\s+unresolved/i);
  assert.match(claude, /location and reason/i);
  assert.match(claude, /do not resolve\s+review\s+threads yourself/i);
  assert.match(claude, /never\s+re-file a finding that already has\s+a thread/i);
  assert.match(claude, /already-commented[\s\S]*same current head/i, 'Claude may skip only when an automated review already targets the current head');
  assert.match(claude, /older head[\s\S]*do not stop/i, 'Claude must continue later rounds after a push');
  assert.match(claude, /rm -rf -- \.review-context\n\s+mkdir -- \.review-context/, 'Claude must replace an untrusted context symlink before writing');
  assert.doesNotMatch(claude, /mkdir -p \.review-context/, 'Claude must not follow a PR-controlled context symlink');
  assert.doesNotMatch(claude, /--comment/);
  assert.doesNotMatch(claude, /Bash\(gh pr comment:\*\)/);
  assert.doesNotMatch(claude, /mcp__github_inline_comment__create_inline_comment/);
  assert.match(claude, /--json-schema/);
  assert.match(claude, /Set outcome to "failed"/);
  const inlineSchema = claude.match(/--json-schema '([^\n]+)'/);
  assert.ok(inlineSchema, 'Claude must receive a JSON schema');
  const { $schema, ...sharedSchema } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.deepEqual(JSON.parse(inlineSchema[1]), sharedSchema);
  assert.match(claude, /name: Write Claude review artifact/);
  assert.match(claude, /name: review-output/);
  assert.match(claude, /outputs:\n      artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(claude, /- name: Upload Claude review output\n        id: upload\n/);
  assert.match(claude, /path: review-output\/review-findings\.json/);
  assert.match(claude, /if-no-files-found: error/);
  assert.deepEqual(
    [...claude.matchAll(/Bash\((git(?::\*| [^)]+))\)/g)].map(([, command]) => command).sort(),
    ['git log:*', 'git rev-parse:*'],
    'Claude may run only the intended read-only Git subcommands',
  );

  // ci.yml starts this workflow only after verify succeeds: nothing in it may poll for CI.
  assert.doesNotMatch(workflow, /wait-for-ci|--wait\b/);

  const codex = job(workflow, 'codex-review');
  assert.match(codex, /needs: \[validate-provider, review-round\]\n/);
  assert.match(codex, /outputs:\n      artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(codex, /- name: Upload Codex review output\n        id: upload\n/);
  assert.match(codex, /needs\.review-round\.outputs\.can_review == 'true'/);
  assert.match(codex, /permissions:\n      actions: read\n      contents: read\n      pull-requests: read/);
  assert.doesNotMatch(codex, /pull-requests: write/);
  assert.match(codex, /openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.equal((workflow.match(/secrets\.OPENAI_API_KEY/g) || []).length, 1, 'only the Codex job may reference OPENAI_API_KEY');
  assert.doesNotMatch(codex, /allow-bots: true/);
  assert.match(codex, /allow-bot-users: 'claude\[bot\]'/);
  assert.match(codex, /allow-users: '\*'/);
  assert.match(codex, /ref: refs\/pull\/\$\{\{ needs\.review-round\.outputs\.pr_number \}\}\/merge/);
  assert.match(codex, /fetch-depth: 0/);
  assert.match(codex, /persist-credentials: false/);
  assert.match(codex, /path: pull-request/);
  assert.match(codex, /name: Fetch prior automated review context/);
  assert.match(codex, /gh api --paginate "\/repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/reviews" --jq '\.\[\]' > pull-request\/\.review-context\/prior-review-bodies\.jsonl/);
  assert.match(codex, /gh api --paginate "\/repos\/\$GITHUB_REPOSITORY\/pulls\/\$PR_NUMBER\/comments" --jq '\.\[\]' > pull-request\/\.review-context\/prior-inline-comments\.jsonl/);
  assert.match(codex, /rm -rf -- pull-request\/\.review-context\n\s+mkdir -- pull-request\/\.review-context/, 'Codex must replace an untrusted context symlink before writing');
  assert.doesNotMatch(codex, /mkdir -p pull-request\/\.review-context/, 'Codex must not follow a PR-controlled context symlink');
  assert.match(codex, /name: Fetch CI workflow results/);
  assert.match(codex, /HEAD_SHA: \$\{\{ needs\.review-round\.outputs\.head_sha \}\}/);
  assert.match(codex, /node trusted-review\/\.github\/scripts\/fetch-ci-results\.cjs/);
  assert.match(codex, /--out pull-request\/\.review-context\/ci-results\.md/);
  assert.match(codex, /--require-success/);
  assert.doesNotMatch(codex, /node pull-request\/\.github\/scripts\/fetch-ci-results/);
  assert.doesNotMatch(codex, /TMPDIR:/, 'codex-review must not add a writable TMPDIR');
  assert.match(codex, /name: Checkout trusted review instructions/);
  assert.match(codex, /ref: \$\{\{ needs\.review-round\.outputs\.base_sha \}\}/);
  assert.match(codex, /path: trusted-review/);
  assert.match(codex, /prompt-file: trusted-review\/\.github\/codex\/prompts\/review\.md/);
  assert.match(codex, /output-schema-file: trusted-review\/\.github\/schemas\/review-findings\.schema\.json/);
  const codexPrompt = fs.readFileSync(promptPath, 'utf8');
  assert.match(codexPrompt, /Set `outcome` to `failed`/);
  assert.match(codexPrompt, /\.review-context\/prior-review-bodies\.jsonl/);
  assert.match(codexPrompt, /\.review-context\/prior-inline-comments\.jsonl/);
  assert.match(codexPrompt, /\.review-context\/ci-results\.md/);
  assert.match(codexPrompt, /read `\.review-context\/ci-results\.md`/i);
  assert.match(codexPrompt, /each\s+earlier actionable\s+finding/i);
  assert.match(codexPrompt, /one `prior_findings` entry/i);
  assert.match(codexPrompt, /addressed or\s+remains\s+unresolved/i);
  assert.match(codexPrompt, /location and reason/i);
  assert.match(codexPrompt, /do not resolve\s+review\s+threads yourself/i);
  assert.match(codexPrompt, /never\s+re-file a finding that already has\s+a thread/i);
  assertCodexEnvironment(codexPrompt);
  assert.match(codex, /working-directory: pull-request/);

  assert.match(codex, /continue-on-error: true/, 'the Codex step must hand control on, not fail the job outright');
  const stepTimeout = codex.match(/^ {8}timeout-minutes: (\d+)$/m);
  assert.ok(stepTimeout, 'the Codex step needs its own timeout-minutes');
  const jobTimeout = codex.match(/^ {4}timeout-minutes: (\d+)$/m);
  assert.ok(jobTimeout, 'the codex-review job needs a timeout-minutes');
  assert.ok(
    Number(stepTimeout[1]) < Number(jobTimeout[1]),
    `the Codex step timeout (${stepTimeout[1]}m) must fire before the job timeout (${jobTimeout[1]}m), or the publishing steps get skipped`,
  );
  assert.match(codex, /name: Require a complete Codex review/);
  assert.match(codex, /REVIEW_OUTCOME: \$\{\{ steps\.codex-review\.outcome \}\}/);
  assert.match(codex, /if \[ ! -s "\$FINDINGS" \]; then\n\s+echo "::error::/, 'a missing review file must fail loudly');
  assert.match(codex, /jq -e 'type == "object"' "\$FINDINGS"/, 'a truncated or non-object review file must fail loudly');
  assert.match(codex, /actions\/upload-artifact@[0-9a-f]{40}[\s\S]*?name: review-output/);

  const poster = job(workflow, 'post-review');
  assert.match(poster, /if: \$\{\{ always\(\) &&/);
  assert.match(poster, /needs: \[validate-provider, review-round, claude-review, codex-review\]/);
  assert.match(poster, /needs\.review-round\.outputs\.can_review == 'false'/);
  assert.match(poster, /name: Download review output\n\s+if: needs\.review-round\.outputs\.can_review == 'true'/, 'only a real review round has an artifact to download');
  assert.doesNotMatch(poster, /name: (?:Checkout trusted validator|Validate and post review findings)\n\s+if:/, 'a skipped round still reports open threads');
  assert.match(poster, /new_threads: \$\{\{ steps\.post\.outputs\.new_threads \}\}/);
  assert.match(poster, /open_threads: \$\{\{ steps\.post\.outputs\.open_threads \}\}/);
  assert.match(poster, /CAN_REVIEW: \$\{\{ needs\.review-round\.outputs\.can_review \}\}/);
  assert.match(poster, /timeout-minutes: 5/);
  assert.match(poster, /permissions:\n(?: +#.*\n)+      contents: write\n      pull-requests: write/, 'resolving a thread needs contents: write on the workflow token');
  assert.equal((workflow.match(/pull-requests: write/g) || []).length, 1, 'post-review is the sole write-scoped job');
  assert.equal((workflow.match(/contents: write/g) || []).length, 1, 'post-review is the sole contents-write job');
  assert.equal((poster.match(/actions\/checkout@/g) || []).length, 1, 'post-review checks out only the trusted base');
  assert.match(poster, /ref: \$\{\{ needs\.review-round\.outputs\.base_sha \}\}\n\s+persist-credentials: false/);
  assert.match(poster, /name: Checkout trusted validator/);
  assert.match(poster, /ref: \$\{\{ needs\.review-round\.outputs\.base_sha \}\}/);
  assert.doesNotMatch(poster, /refs\/pull\/\$\{\{ github\.event\.pull_request\.number \}\}\/merge/);
  assert.doesNotMatch(poster, /name: review-output/, 'a name is not trusted: PR code in the same CI run can upload one');
  assert.match(poster, /actions\/download-artifact@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+artifact-ids: \$\{\{ needs\.validate-provider\.outputs\.provider == 'claude' && needs\.claude-review\.outputs\.artifact_id \|\| needs\.codex-review\.outputs\.artifact_id \}\}\n\s+merge-multiple: true\n\s+path: review-output\n/);
  assert.ok(poster.indexOf("name: Require the provider's review artifact ID") < poster.indexOf('name: Download review output'),
    'an empty artifact ID downloads every artifact in the run, so it must fail before the download');
  assert.match(poster, /actions\/github-script@[0-9a-f]{40}/);
  assert.match(poster, /require\('\.\/\.github\/scripts\/automated-review\.cjs'\)/);
  assert.doesNotMatch(poster, /codex-review\.js/);
  assert.match(poster, /PROVIDER: \$\{\{ needs\.validate-provider\.outputs\.provider \}\}/);
  assert.match(poster, /github\.paginate\(github\.rest\.pulls\.listFiles/);
  assert.match(poster, /PR_NUMBER: \$\{\{ needs\.review-round\.outputs\.pr_number \}\}/);
  assert.match(poster, /HEAD_SHA: \$\{\{ needs\.review-round\.outputs\.head_sha \}\}/);
  assert.match(poster, /const pullNumber = Number\(process\.env\.PR_NUMBER\)/);
  assert.match(poster, /const eventHeadSha = process\.env\.HEAD_SHA/);
  assert.match(poster, /noFindingsSummary: 'No issues found'/);
  assert.doesNotMatch(poster, /noFindingsSummary: process\.env\.PROVIDER/);
  assert.match(poster, /\n              eventHeadSha,/);
  assert.match(poster, /reviewedHeadSha: review\.head_sha/);
  assert.doesNotMatch(poster, /resolveReviewThread/, 'thread resolution lives in the tested helper, not inline workflow script');
  assert.ok(poster.indexOf('await postReview(') < poster.indexOf('applyVerdicts('), 'findings are posted before verdicts, so a red check still shows them');
  assert.match(poster, /assertLiveHead\(\{[^}]*reviewedHeadSha: review\.head_sha \}\);\n\s+const threads = await listReviewThreads/, 'verdicts are applied only while the reviewed head is live');
  assert.match(poster, /core\.setOutput\('new_threads', String\(newThreads\)\)/);
  assert.match(poster, /core\.setOutput\('open_threads', String\(countOpenAutomatedThreads\(threads\)\)\)/);

  const aggregate = job(workflow, 'review-complete');
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /needs: \[validate-provider, review-round, claude-review, codex-review, post-review\]/);
  assert.match(aggregate, /name: Review verdict/);
  assert.doesNotMatch(aggregate, /name: Automated Code Review/, 'the required check name belongs to ci.yml, not to a called job');
  assert.match(aggregate, /\[ "\$VALIDATE_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /claude\) \[ "\$CLAUDE_RESULT" = 'success' \] \|\| exit 1 ;;/);
  assert.match(aggregate, /codex\) \[ "\$CODEX_RESULT" = 'success' \] \|\| exit 1 ;;/);
  assert.match(aggregate, /\[ "\$POST_RESULT" = 'success' \] \|\| exit 1/);
  assert.match(aggregate, /REVIEW_ROUND_RESULT: \$\{\{ needs\.review-round\.result \}\}/);
  assert.match(aggregate, /CAN_REVIEW: \$\{\{ needs\.review-round\.outputs\.can_review \}\}/);
  assert.match(aggregate, /\[ "\$REVIEW_ROUND_RESULT" = 'success' \] \|\| exit 1/);
  assert.doesNotMatch(aggregate, /\[ "\$CAN_REVIEW" = 'false' \] && exit 0/, 'a skipped round must still fail on open threads');

  const validator = job(workflow, 'validate-provider');
  assert.match(validator, /permissions:\n      contents: read\n      pull-requests: read/);
  assert.doesNotMatch(validator, /permissions: \{\}/);
  assert.doesNotMatch(validator, /contents: write|pull-requests: write/);
  assert.match(validator, /name: Reject untrusted bot actors/);
  assert.match(validator, /ACTOR: \$\{\{ github\.actor \}\}/);
  assert.match(validator, /HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(validator, /PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(validator, /release-bump-pr\.cjs/);
  assert.match(validator, /classifyFromEnv/);
  assert.match(validator, /\[\[ "\$ACTOR" == \*'\[bot\]' && "\$ACTOR" != 'claude\[bot\]' \]\]/);
  assert.ok(validator.indexOf('name: Reject untrusted bot actors') < validator.indexOf('id: provider'), 'bot guard must run before provider validation and the wildcard action allowlist');
  assert.match(aggregate, /permissions: \{\}/);
  assert.equal((workflow.match(/applyVerdicts\(/g) || []).length, 1, 'only post-review applies verdicts to threads');
});

test('bot-authored release/v* PRs set can_review=false without spending a review round', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const round = job(workflow, 'review-round');
  assert.match(round, /HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(round, /PR_AUTHOR: \$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(round, /head_ref="\$\{HEAD_REF:-\}"/);
  assert.match(round, /pr_author="\$\{PR_AUTHOR:-\}"/);
  assert.match(round, /\.cez-trusted\/\.github\/scripts\/release-bump-pr\.cjs/);
  assert.match(round, /classifyFromEnv/);
  assert.match(round, /can_review=false/);
  assert.match(round, /Checkout trusted classifier from base/);
  // Manual dispatch still reviews even when the PR is a bump.
  assert.match(round, /EVENT_NAME" = workflow_dispatch[\s\S]*can_review=true/);
});

test('automated review rounds read AUTOMATED_REVIEW_ROUNDS and ignore the cap on workflow_dispatch', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const round = job(workflow, 'review-round');
  const claude = job(workflow, 'claude-review');
  const codex = job(workflow, 'codex-review');
  const poster = job(workflow, 'post-review');

  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      pr_number:\n(?:.*\n)*?        required: true/);
  assert.match(workflow, /github\.event\.pull_request\.number \|\| inputs\.pr_number/);
  assert.match(round, /AUTOMATED_REVIEW_ROUNDS: \$\{\{ vars\.AUTOMATED_REVIEW_ROUNDS \}\}/);
  assert.match(round, /\[ -z "\$AUTOMATED_REVIEW_ROUNDS" \]/);
  assert.match(round, /AUTOMATED_REVIEW_ROUNDS=3/);
  assert.match(round, /\^\[1-9\]\[0-9\]\*\$/);
  assert.match(round, /AUTOMATED_REVIEW_ROUNDS must be a positive integer/);
  assert.match(round, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(round, /EVENT_NAME" = workflow_dispatch/);
  assert.match(round, /review_count" -lt "\$AUTOMATED_REVIEW_ROUNDS"/);
  assert.doesNotMatch(round, /review_count" -lt 3/);
  const roundsBinding = fs.readFileSync(agentsPath, 'utf8').match(/^\| Automated review rounds \|.*$/m);
  assert.ok(roundsBinding, 'AGENTS.md must keep the Automated review rounds binding row');
  // The configured value changes in GitHub, not here: the row names how to read the cap and never states its value.
  assert.match(roundsBinding[0], /`AUTOMATED_REVIEW_ROUNDS` repository variable/);
  assert.match(roundsBinding[0], /`gh variable get AUTOMATED_REVIEW_ROUNDS`/);
  assert.match(roundsBinding[0], /falls back to 3 only when the variable is unset or empty/);
  assert.doesNotMatch(roundsBinding[0].replace('falls back to 3', ''), /\d/);

  assert.match(round, /PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \|\| inputs\.pr_number \}\}/);
  assert.match(claude, /PR_NUMBER: \$\{\{ needs\.review-round\.outputs\.pr_number \}\}/);
  assert.match(claude, /needs\.review-round\.outputs\.head_sha/);
  assert.match(codex, /PR_NUMBER: \$\{\{ needs\.review-round\.outputs\.pr_number \}\}/);
  assert.match(poster, /PR_NUMBER: \$\{\{ needs\.review-round\.outputs\.pr_number \}\}/);
  assert.match(poster, /AUTOMATED_REVIEW_ROUNDS: \$\{\{ vars\.AUTOMATED_REVIEW_ROUNDS \}\}/);
  assert.match(poster, /IGNORE_CAP: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(poster, /ignoreCap: process\.env\.IGNORE_CAP === 'true'/);
  assert.match(poster, /maxRounds,/);
  assert.doesNotMatch(claude, /github\.event\.pull_request\./);
  assert.doesNotMatch(codex, /github\.event\.pull_request\./);
  assert.doesNotMatch(poster, /context\.payload\.pull_request/);
});

test('each review provider interpolates only its own model and effort variables', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const claude = job(workflow, 'claude-review');
  const codex = job(workflow, 'codex-review');

  assert.match(claude, /--model \$\{.*vars\.CLAUDE_REVIEW_MODEL \|\| 'sonnet'/);
  assert.match(claude, /--max-turns 40/);
  assert.match(
    claude,
    /vars\.CLAUDE_REVIEW_EFFORT && format\('--effort \{0\}', vars\.CLAUDE_REVIEW_EFFORT\) \|\| ''/,
  );
  assert.doesNotMatch(claude, /^\s*--effort\s+\S/m, 'Claude --effort is omitted unless CLAUDE_REVIEW_EFFORT is set');
  assert.doesNotMatch(claude, /vars\.CODEX_REVIEW_/);
  assert.doesNotMatch(claude, /vars\.REVIEW_(?:MODEL|EFFORT)\b/);

  assert.match(codex, /model: \$\{.*vars\.CODEX_REVIEW_MODEL \|\| 'gpt-5\.6-luna'/);
  assert.match(codex, /effort: \$\{.*vars\.CODEX_REVIEW_EFFORT \|\| 'max'/);
  assert.doesNotMatch(codex, /vars\.CLAUDE_REVIEW_/);
  assert.doesNotMatch(codex, /vars\.REVIEW_(?:MODEL|EFFORT)\b/);
});

test('later-round review prompts judge thread replies as evidence', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const claude = job(workflow, 'claude-review');
  const codexPrompt = fs.readFileSync(promptPath, 'utf8');

  assertLaterRoundThreadPushback(claude, 'Claude later-round prompt');
  assertLaterRoundThreadPushback(codexPrompt, 'Codex later-round prompt');
});

function assertLaterRoundThreadPushback(prompt, label) {
  assert.match(prompt, /in_reply_to_id/, `${label} must group prior comments by thread`);
  assert.match(prompt, /group[\s\S]*thread/i, `${label} must group prior comments by thread`);
  assert.match(prompt, /read[\s\S]*thread/i, `${label} must read thread replies under each earlier finding`);
  assert.match(prompt, /valid pushback/i, `${label} must evaluate implementer pushback`);
  assert.match(prompt, /no code change/i, `${label} must treat valid pushback as addressed without a code change`);
  assert.match(prompt, /invalid pushback/i, `${label} must keep invalid pushback unresolved`);
  assert.match(prompt, /why the reply fails/i, `${label} must name why invalid pushback fails`);
  assert.match(prompt, /do not resolve\s+review\s+threads yourself/i, `${label} must leave thread resolution to CI`);
  assert.match(prompt, /prior_findings/, `${label} must return a verdict per earlier thread`);
}

test('review schema requires every object property and models optional values as nullable', () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const finding = schema.properties.findings.items;

  function assertAllPropertiesRequired(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.deepEqual(
        [...node.required].sort(),
        Object.keys(node.properties).sort(),
        'every declared object property must be required',
      );
    }
    for (const value of Object.values(node)) assertAllPropertiesRequired(value);
  }

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.outcome.enum, ['reviewed', 'skipped', 'failed']);
  assert.deepEqual(schema.properties.head_sha.type, ['string', 'null']);
  assert.equal(finding.additionalProperties, false);
  assert.equal(finding.properties.body.pattern, '\\S');
  assert.deepEqual(schema.properties.summary.type, ['string', 'null']);
  assert.deepEqual(finding.properties.severity.type, ['string', 'null']);
  assert.ok(finding.properties.severity.enum.includes(null));
  assertAllPropertiesRequired(schema);
});


const bot = { login: 'github-actions[bot]' };
// Same history as roundHistory in automated-review.test.cjs: ten rounds, among
// them unmarked or malformed legacy rounds and whitespace-only bodies (ASCII,
// U+00A0, U+FEFF), among empty-body verdict-reply reviews, non-string bodies, a
// pending and a human review. Both sides require a string body and neither trims,
// so jq and JS agree byte for byte.
const roundHistory = [
  { id: 1, user: bot, submitted_at: '2026-10-01T10:00:00Z', body: `<!-- cez-review-patch-id: ${'1'.repeat(40)} -->` },
  { id: 2, user: bot, submitted_at: '2026-10-01T10:01:00Z', body: '' },
  { id: 3, user: bot, submitted_at: '2026-10-01T10:02:00Z', body: `summary\n\n<!-- cez-review-patch-id: ${'2'.repeat(40)} -->` },
  { id: 4, user: bot, submitted_at: '2026-10-01T10:03:00Z', body: '' },
  { id: 5, user: bot, submitted_at: '2026-10-01T10:04:00Z', body: 'summary\n\n<!-- cez-review-round -->' },
  { id: 6, user: bot, submitted_at: '2026-10-01T10:05:00Z', body: `<!-- cez-review-round -->\n\n<!-- cez-review-patch-id: ${'3'.repeat(40)} -->` },
  { id: 7, user: bot, submitted_at: '2026-10-01T10:06:00Z', body: '' },
  { id: 8, user: bot, submitted_at: '2026-10-01T10:07:00Z', body: null },
  { id: 9, user: bot, submitted_at: null, body: '<!-- cez-review-round -->' },
  { id: 10, user: { login: 'octocat' }, submitted_at: '2026-10-01T10:08:00Z', body: '<!-- cez-review-round -->' },
  { id: 11, user: bot, submitted_at: '2026-10-01T10:09:00Z', body: `<!-- cez-review-patch-id: ${'4'.repeat(39)} -->` },
  { id: 12, user: bot, submitted_at: '2026-10-01T10:10:00Z', body: 'No issues found' },
  { id: 13, user: bot, submitted_at: '2026-10-01T10:11:00Z', body: 'Guard the null input before parsing.' },
  { id: 14, user: bot, submitted_at: '2026-10-01T10:12:00Z', body: ' \n\t' },
  { id: 15, user: bot, submitted_at: '2026-10-01T10:13:00Z', body: '\u00a0' },
  { id: 16, user: bot, submitted_at: '2026-10-01T10:14:00Z', body: '\ufeff' },
  { id: 17, user: bot, submitted_at: '2026-10-01T10:15:00Z', body: 42 },
  { id: 18, user: bot, submitted_at: '2026-10-01T10:16:00Z', body: true },
  { id: 19, user: bot, submitted_at: '2026-10-01T10:17:00Z', body: {} },
  { id: 20, user: bot, submitted_at: '2026-10-01T10:18:00Z', body: [] },
];

test('review-round counts rounds by the same rule as countAutomatedReviews', async () => {
  const { parse } = await import('yaml');
  const { execFileSync } = require('node:child_process');
  const { countAutomatedReviews } = require('./automated-review.cjs');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const round = workflow.jobs['review-round'].steps.find((step) => step.id === 'review-round');
  const filter = round.run.match(/review_count="\$\(gh api [^\n]*?--jq '([^']+)'/)?.[1];
  assert.ok(filter, 'review-round must count reviews through a --jq filter');
  const counted = execFileSync('jq', ['-r', filter], { input: JSON.stringify(roundHistory), encoding: 'utf8' }).split('\n').filter(Boolean).length;
  assert.equal(counted, countAutomatedReviews(roundHistory));
  assert.equal(counted, 10);
});

test('review-round skips when the three-dot patch-id matches the last posted marker', async (t) => {
  const { parse } = await import('yaml');
  const { execFileSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const roundJob = workflow.jobs['review-round'];
  const trusted = roundJob.steps.find((step) => step.name === 'Checkout trusted classifier from base');
  assert.equal(trusted?.with?.path, '.cez-trusted');
  assert.equal(trusted?.with?.ref, '${{ github.event.pull_request.base.sha || github.sha }}');
  assert.equal(trusted?.with?.['persist-credentials'], false);
  const checkout = roundJob.steps.find((step) => step.name === 'Checkout pull request merge for patch-id');
  assert.equal(checkout?.with?.['persist-credentials'], false);
  assert.equal(checkout?.with?.['allow-unsafe-pr-checkout'], true);
  assert.match(checkout?.with?.ref || '', /refs\/pull\/.*\/merge/);
  const round = roundJob.steps.find((step) => step.id === 'review-round');
  assert.match(round.run, /git diff --full-index/);
  assert.match(round.run, /git patch-id --stable/);
  assert.match(round.run, /cez-review-patch-id/);
  assert.match(roundJob.outputs.patch_id, /steps\.review-round\.outputs\.patch_id/);

  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const patchId = 'c'.repeat(40);
  const marker = `<!-- cez-review-patch-id: ${patchId} -->`;

  // `reviews` serves /reviews as real JSON through real `jq -r` and the --jq
  // filter the script passed; `reviewsOut` is the canned filter output.
  async function runRound({ event, gitOk, reviewsOut, reviews, headRef = '', prAuthor = '', filesOut = 'packages/cezar/src/index.ts', liveHead = head, filesOk = true }) {
    const cwd = fs.mkdtempSync(path.join(tmpdir(), 'review-patch-id-'));
    const output = path.join(cwd, 'outputs');
    const scriptsDir = path.join(cwd, '.cez-trusted', '.github', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'release-bump-pr.cjs'), path.join(scriptsDir, 'release-bump-pr.cjs'));
    // Stub version-stamp compare so bash harnesses do not need real file contents.
    const classifierSrc = fs.readFileSync(path.join(scriptsDir, 'release-bump-pr.cjs'), 'utf8');
    const stamped = classifierSrc.replace(
      /function filesAreVersionStampsOnly\(\{[\s\S]*?\} = \{\}\) \{/,
      (match) => `${match}\n  if (env.TEST_STAMPS_OK === '1') return true;\n  if (env.TEST_STAMPS_OK === '0') return false;`,
    );
    assert.notEqual(stamped, classifierSrc, 'expected version-stamp stub injection');
    fs.writeFileSync(path.join(scriptsDir, 'release-bump-pr.cjs'), stamped);
    // `git` runs as a real process on a real pipe, not a shell function: the
    // old function stub let the `git patch-id` stage exit before `git diff`
    // wrote, so the writer hit EPIPE, pipefail failed the substitution, and
    // the skip failed open (#424). The stub drains stdin like real
    // `git patch-id`, so the pipeline is deterministic: one 40-hex id on
    // success, a failing exit on compute failure.
    const binDir = path.join(cwd, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const gitShim = gitOk
      ? `#!/bin/sh
case "$1" in
  diff|patch-id) ;;
  *) echo "unexpected git: $*" >&2; exit 1 ;;
esac
if [ "$1" = patch-id ]; then
  cat >/dev/null
fi
printf '%s ignored\\n' '${patchId}'
`
      : `#!/bin/sh
echo 'missing objects' >&2
exit 128
`;
    fs.writeFileSync(path.join(binDir, 'git'), gitShim);
    fs.chmodSync(path.join(binDir, 'git'), 0o755);
    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      BASH_ENV: '/dev/null',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'owner/repo',
      PR_NUMBER: '220',
      EVENT_NAME: event,
      AUTOMATED_REVIEW_ROUNDS: '3',
      EVENT_HEAD_SHA: event === 'workflow_dispatch' ? '' : head,
      EVENT_BASE_SHA: event === 'workflow_dispatch' ? '' : base,
      HEAD_REF: headRef,
      PR_AUTHOR: prAuthor,
      GH_TOKEN: 'test-token',
      TEST_STAMPS_OK: '1',
    };
    if (reviews) {
      env.TEST_REVIEWS_JSON = path.join(cwd, 'reviews.json');
      fs.writeFileSync(env.TEST_REVIEWS_JSON, JSON.stringify(reviews));
    }
    const filesLiteral = filesOut.replace(/'/g, `'\\''`);
    const filesBranch = filesOk
      ? `printf '%s\\n' '${filesLiteral}'`
      : `echo 'page failed' >&2; return 1`;
    const script = [
      `gh() { case "$*" in *'.head.sha'*) echo '${liveHead}';; *'.base.sha'*) echo '${base}';; *'/files'*) ${filesBranch};; *'/reviews'*) if [ -n "\${TEST_REVIEWS_JSON:-}" ]; then while [ "$1" != --jq ]; do shift; done; jq -r "$2" "$TEST_REVIEWS_JSON"; else printf '%s\\n' '${reviewsOut}'; fi;; *) echo "unexpected gh: $*" >&2; return 1;; esac; }`,
      round.run,
    ].join('\n');
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', script], { cwd, env });
      return Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)];
      }));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  await t.test('matching marker skips without consuming a round', async () => {
    const outputs = await runRound({ event: 'pull_request_target', gitOk: true, reviewsOut: marker });
    assert.equal(outputs.can_review, 'false');
    assert.equal(outputs.patch_id, patchId);
  });

  await t.test('missing marker still reviews', async () => {
    const outputs = await runRound({ event: 'pull_request_target', gitOk: true, reviewsOut: 'No issues found' });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('mismatch still reviews', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: `<!-- cez-review-patch-id: ${'d'.repeat(40)} -->`,
    });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('compute failure reviews instead of skipping', async () => {
    const outputs = await runRound({ event: 'pull_request_target', gitOk: false, reviewsOut: marker });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('workflow_dispatch still reviews past the patch-id skip', async () => {
    const outputs = await runRound({ event: 'workflow_dispatch', gitOk: true, reviewsOut: marker });
    assert.equal(outputs.can_review, 'true');
  });

  // Round 2 is an unmarked legacy round (dispatch or a failed patch-id).
  const history = (rounds) => [
    { id: 1, user: bot, submitted_at: '2026-10-01T10:00:00Z', body: `<!-- cez-review-patch-id: ${'d'.repeat(40)} -->` },
    { id: 2, user: bot, submitted_at: '2026-10-01T10:10:00Z', body: 'No issues found' },
    { id: 3, user: bot, submitted_at: '2026-10-01T10:20:00Z', body: `<!-- cez-review-round -->\n\n<!-- cez-review-patch-id: ${'e'.repeat(40)} -->` },
  ].slice(0, rounds).concat(Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, user: bot, submitted_at: `2026-10-01T11:0${i}:00Z`, body: '' })));

  await t.test('verdict-reply reviews do not spend the round cap', async () => {
    const outputs = await runRound({ event: 'pull_request_target', gitOk: true, reviews: history(2) });
    assert.equal(outputs.can_review, 'true');
    assert.equal(outputs.patch_id, patchId);
  });

  await t.test('the cap stops the round after AUTOMATED_REVIEW_ROUNDS rounds', async () => {
    const outputs = await runRound({ event: 'pull_request_target', gitOk: true, reviews: history(3) });
    assert.equal(outputs.can_review, 'false');
    assert.equal(outputs.patch_id, '', 'the cap, not the patch-id skip, stopped the round');
  });

  await t.test('bot-authored release/v* head skips review when files are manifest-only', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: 'No issues found',
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      filesOut: 'packages/cezar/package.json\npnpm-lock.yaml',
    });
    assert.equal(outputs.can_review, 'false');
    assert.equal(outputs.patch_id, '');
  });

  await t.test('bot-authored release/v* head still reviews when files leave the allowlist', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: 'No issues found',
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      filesOut: 'packages/cezar/package.json\n.github/workflows/ci.yml',
    });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('bot-authored release/v* head still reviews when live head drifts', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: 'No issues found',
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      filesOut: 'packages/cezar/package.json\npnpm-lock.yaml',
      liveHead: 'd'.repeat(40),
    });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('bot-authored release/v* head still reviews when file list fetch fails', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: 'No issues found',
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      filesOut: 'packages/cezar/package.json\npnpm-lock.yaml',
      filesOk: false,
    });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('human-authored release/v* head still reviews', async () => {
    const outputs = await runRound({
      event: 'pull_request_target',
      gitOk: true,
      reviewsOut: 'No issues found',
      headRef: 'release/v0.13.5',
      prAuthor: 'human',
      filesOut: 'packages/cezar/package.json\npnpm-lock.yaml',
    });
    assert.equal(outputs.can_review, 'true');
  });

  await t.test('workflow_dispatch still reviews a bot release/v* PR', async () => {
    const outputs = await runRound({
      event: 'workflow_dispatch',
      gitOk: true,
      reviewsOut: marker,
      headRef: 'release/v0.13.5',
      prAuthor: 'github-actions[bot]',
      filesOut: 'packages/cezar/package.json\npnpm-lock.yaml',
    });
    assert.equal(outputs.can_review, 'true');
  });
});

test('post-review stamps the computed patch-id onto posted reviews', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const poster = job(workflow, 'post-review');
  assert.match(poster, /PATCH_ID: \$\{\{ needs\.review-round\.outputs\.patch_id \}\}/);
  assert.match(poster, /patchId: process\.env\.PATCH_ID/);
});

test('both model jobs run on provider and round alone, and recheck verification before model work', async () => {
  const { parse } = await import('yaml');
  const { runInNewContext } = require('node:vm');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const expression = condition => condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']");
  for (const provider of ['codex', 'claude']) {
    const modelJob = workflow.jobs[`${provider}-review`];
    // The verification gate is ci.yml's `review: needs: verify`, pinned in the next test.
    assert.deepEqual(modelJob.needs, ['validate-provider', 'review-round']);
    for (const [selected, canReview, runs] of [[provider, 'true', true], [provider, 'false', false], [provider === 'codex' ? 'claude' : 'codex', 'true', false]]) {
      const needs = { 'validate-provider': { outputs: { provider: selected } }, 'review-round': { outputs: { can_review: canReview } } };
      assert.equal(runInNewContext(expression(modelJob.if), { needs }), runs, `${provider}: provider=${selected} can_review=${canReview}`);
    }
    const modelIndex = modelJob.steps.findIndex(step => step.uses?.includes(provider === 'codex' ? 'openai/codex-action' : 'anthropics/claude-code-action'));
    const contextIndex = modelJob.steps.findIndex(step => step.run?.includes('--require-success'));
    assert.ok(contextIndex >= 0 && contextIndex < modelIndex, `${provider} rechecks before model work`);
    const context = modelJob.steps[contextIndex];
    assert.match(context.run, /node trusted-review\/\.github\/scripts\/fetch-ci-results\.cjs/);
    assert.equal(context['continue-on-error'], undefined);
    assert.equal(modelJob.permissions.actions, 'read');
    const trusted = modelJob.steps.find(step => step.with?.path === 'trusted-review');
    assert.equal(trusted?.with.ref, '${{ needs.review-round.outputs.base_sha }}');
    assert.equal(trusted?.with['persist-credentials'], false);
    if (provider === 'claude') {
      const resetIndex = modelJob.steps.findIndex(step => step.run === 'rm -rf -- trusted-review');
      const trustedIndex = modelJob.steps.indexOf(trusted);
      const mergeIndex = modelJob.steps.findIndex(step => step.with?.ref?.startsWith('refs/pull/'));
      assert.ok(mergeIndex < resetIndex && resetIndex < trustedIndex, 'remove the PR-controlled path before trusted checkout');
      assert.equal(modelJob.steps[mergeIndex]?.with?.['allow-unsafe-pr-checkout'], true);
    } else {
      const mergeIndex = modelJob.steps.findIndex(step => step.with?.ref?.startsWith('refs/pull/'));
      assert.equal(modelJob.steps[mergeIndex]?.with?.['allow-unsafe-pr-checkout'], true);
    }
  }
});

test('the Automated Code Review check fails on new or still-open finding threads', async (t) => {
  const { parse } = await import('yaml');
  const { spawnSync } = require('node:child_process');
  const { tmpdir } = require('node:os');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const [step] = workflow.jobs['review-complete'].steps;
  const passing = {
    VALIDATE_RESULT: 'success', REVIEW_ROUND_RESULT: 'success', CAN_REVIEW: 'true', PROVIDER: 'codex',
    CLAUDE_RESULT: 'skipped', CODEX_RESULT: 'success', POST_RESULT: 'success', NEW_THREADS: '0', OPEN_THREADS: '0',
    PR_NUMBER: '42',
  };
  const cwd = fs.mkdtempSync(path.join(tmpdir(), 'review-verdict-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let runs = 0;
  // GitHub always sets GITHUB_STEP_SUMMARY; each run gets its own file.
  const run = (overrides) => {
    const summaryPath = path.join(cwd, `summary-${runs++}.md`);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', step.run], {
      env: { PATH: process.env.PATH, BASH_ENV: '/dev/null', GITHUB_STEP_SUMMARY: summaryPath, ...passing, ...overrides }, encoding: 'utf8',
    });
    return { ...result, summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '' };
  };
  const cases = [
    ['a clean review', {}, 0],
    ['a skip with nothing open', { CAN_REVIEW: 'false', PROVIDER: '', CODEX_RESULT: 'skipped' }, 0],
    ['a review that resolved every earlier thread', { OPEN_THREADS: '0', NEW_THREADS: '0' }, 0],
    ['new findings', { NEW_THREADS: '2', OPEN_THREADS: '2' }, 1],
    ['earlier findings still open', { OPEN_THREADS: '1' }, 1],
    ['a skip while earlier findings are open', { CAN_REVIEW: 'false', PROVIDER: '', CODEX_RESULT: 'skipped', OPEN_THREADS: '1' }, 1],
    ['a provider failure', { CODEX_RESULT: 'failure' }, 1],
    ['an unknown provider', { PROVIDER: 'other' }, 1],
    ['a post failure', { POST_RESULT: 'failure', NEW_THREADS: '', OPEN_THREADS: '' }, 1],
    ['a validation failure', { VALIDATE_RESULT: 'failure' }, 1],
    ['a round failure', { REVIEW_ROUND_RESULT: 'failure' }, 1],
    ['missing thread counts', { NEW_THREADS: '', OPEN_THREADS: '' }, 1],
  ];
  for (const [label, overrides, status] of cases) {
    const result = run(overrides);
    assert.equal(result.status, status, `${label}: ${result.stdout}${result.stderr}`);
  }
  const opened = run({ NEW_THREADS: '2', OPEN_THREADS: '2' });
  const stillOpen = run({ OPEN_THREADS: '3' });
  assert.match(opened.stdout, /opened 2 new finding thread/);
  assert.match(stillOpen.stdout, /3 automated review thread\(s\) are still unresolved/);
  // Re-running a CI round never judges a pushback reply: the patch-ID guard skips the model on an unchanged patch.
  for (const result of [opened, stillOpen]) {
    assert.match(result.stdout, /run this workflow manually with pr_number, then re-run Review \/ review-round/);
    assert.match(result.stdout, /gh workflow run automated-code-review\.yml -f pr_number=42\b/);
  }
  // Re-run failed jobs reruns only the verdict, which reads post-review's old open_threads output.
  assert.match(stillOpen.stdout, /Re-running the failed jobs alone reuses the old count\./);
  assert.match(stillOpen.stdout, /resolved them by hand, re-run Review \/ review-round/);
  // `gh run view` shows the step summary without the log, so it carries the notice text verbatim.
  for (const result of [opened, stillOpen]) {
    const notice = result.stdout.match(/^::notice::(.*)$/m)?.[1];
    assert.ok(notice, result.stdout);
    assert.equal(result.summary, `${notice}\n`);
  }
  assert.equal(run({}).summary, '', 'a green verdict writes no summary');
});

test('App-authored upstream-scan PRs skip review through the trusted classifier', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const validator = job(workflow, 'validate-provider');
  const round = job(workflow, 'review-round');
  assert.match(validator, /c\.classifyFromEnv\(\) \|\| c\.classifyUpstreamScanFromEnv\?\.\(\)/);
  assert.match(round, /c\.classifyFromEnv\(\) \|\| c\.classifyUpstreamScanFromEnv\?\.\(\)/);
});

test('the review is a called workflow plus a manual dispatch, never its own pull request trigger', async () => {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_call.secrets, {
    ANTHROPIC_API_KEY: { required: false },
    OPENAI_API_KEY: { required: false },
  }, 'only the selected provider needs its key, so neither is required');
  assert.equal(workflow.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'workflows', 'recover-automated-review.yml')), false,
    'no review waits on CI any more, so there is no failed wait to recover');
  assert.equal(fs.existsSync(path.join(__dirname, 'recover-review.cjs')), false);
});

test('ci.yml starts the review after verify and owns the required Automated Code Review check', async () => {
  const { parse } = await import('yaml');
  const { runInNewContext } = require('node:vm');
  const { spawnSync } = require('node:child_process');
  const ci = parse(fs.readFileSync(ciPath, 'utf8'));
  const review = parse(fs.readFileSync(workflowPath, 'utf8'));
  const evaluate = (value, context) => runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), { always: () => true, ...context });
  const github = (event_name, base) => ({ event_name, event: { pull_request: base ? { base: { ref: base } } : undefined } });
  const routing = [
    [github('pull_request_target', 'main'), true],
    [github('pull_request_target', 'release/v1.2.3'), false],
    [github('push'), false],
    [github('workflow_dispatch'), false],
  ];

  const caller = ci.jobs.review;
  assert.equal(caller.uses, './.github/workflows/automated-code-review.yml');
  assert.equal(caller.needs, 'verify', 'the review starts when verification succeeds, so no job waits for CI');
  assert.deepEqual(caller.secrets, {
    ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}',
    OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}',
  }, 'pass the model keys alone, never `secrets: inherit`');
  // GitHub wraps a job `if:` holding no status function in `success()`, and that `success()`
  // is false once any job upstream, however far, did not succeed: a skipped shard included.
  const upstream = name => {
    const seen = new Set();
    const walk = job => [ci.jobs[job].needs ?? []].flat().forEach(dep => seen.has(dep) || (seen.add(dep), walk(dep)));
    walk(name);
    return [...seen];
  };
  const runs = (name, { github: context, results, cancelled = false }) => {
    const job = ci.jobs[name];
    const condition = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const before = upstream(name).map(dep => results[dep]);
    return evaluate(/\b(success|failure|cancelled|always)\(/.test(condition) ? condition : `success() && (${condition})`, {
      github: context,
      needs: Object.fromEntries([job.needs].flat().map(dep => [dep, { result: results[dep] }])),
      cancelled: () => cancelled,
      success: () => !cancelled && before.every(result => result === 'success'),
      failure: () => before.includes('failure'),
    });
  };
  const shards = ['vitest', 'node-floor', 'cockpit-browser'];
  const outcome = (shardResult, verifyResult) => Object.fromEntries(Object.keys(ci.jobs).map(job => [job,
    job === 'verify' ? verifyResult : shards.includes(job) ? shardResult : 'success']));
  for (const [context, expected] of routing) {
    assert.equal(runs('review', { github: context, results: outcome('success', 'success') }), expected, JSON.stringify(context));
  }
  const pr = routing[0][0];
  // Docs-only, infra-only and verified bump PRs skip every shard by design, and verify succeeds.
  assert.equal(runs('review', { github: pr, results: outcome('skipped', 'success') }), true,
    'a verify that succeeds after skipped shards must still start the review');
  for (const [shardResult, verifyResult] of [['failure', 'failure'], ['cancelled', 'cancelled'], ['skipped', 'failure'], ['success', 'skipped']]) {
    assert.equal(runs('review', { github: pr, results: outcome(shardResult, verifyResult) }), false, `verify ${verifyResult}`);
  }
  assert.equal(runs('review', { github: pr, results: outcome('skipped', 'success'), cancelled: true }), false,
    'a cancelled run starts no review');

  // A called job asking for more than the caller grants fails the whole run; granting more
  // than any called job uses widens every called job's ceiling for nothing.
  const rank = { none: 0, read: 1, write: 2 };
  const union = {};
  for (const [name, called] of Object.entries(review.jobs)) {
    assert.ok(called.permissions, `${name} must declare its own permissions so it never inherits the caller's ceiling`);
    for (const [scope, level] of Object.entries(called.permissions)) {
      if ((rank[level] ?? 0) > (rank[union[scope]] ?? 0)) union[scope] = level;
    }
  }
  assert.deepEqual(caller.permissions, union);

  const named = Object.values(ci.jobs).filter(j => typeof j.name === 'string' && j.name.includes('Automated Code Review'));
  assert.equal(named.length, 1, 'exactly one ci.yml job carries the required check name');
  const result = ci.jobs['review-result'];
  assert.deepEqual(result.needs, ['verify', 'review', 'queue-admission']);
  assert.deepEqual(result.permissions, {});
  for (const [context, expected] of routing) {
    assert.equal(evaluate(result.if, { github: context }), expected, JSON.stringify(context));
    // A skipped job reports success: under the required name it would pass the check unreviewed.
    assert.equal(evaluate(result.name, { github: context }) === 'Automated Code Review', expected, JSON.stringify(context));
  }

  const [step] = result.steps;
  const run = env => spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', step.run], {
    env: { PATH: process.env.PATH, BASH_ENV: '/dev/null', EVENT_NAME: 'pull_request_target', ...env }, encoding: 'utf8',
  });
  assert.equal(run({ VERIFY_RESULT: 'success', REVIEW_RESULT: 'success' }).status, 0);
  for (const reviewResult of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(run({ VERIFY_RESULT: 'success', REVIEW_RESULT: reviewResult }).status, 0, `review ${reviewResult}`);
  }
  for (const verifyResult of ['failure', 'cancelled', 'skipped']) {
    const failed = run({ VERIFY_RESULT: verifyResult, REVIEW_RESULT: 'skipped' });
    assert.notEqual(failed.status, 0, `verify ${verifyResult}`);
    assert.match(failed.stderr, /Re-run failed jobs/);
  }
});

test("post-review refuses to download without the provider job's artifact ID", async () => {
  const { parse } = await import('yaml');
  const { spawnSync } = require('node:child_process');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const guard = workflow.jobs['post-review'].steps.find(step => step.name === "Require the provider's review artifact ID");
  assert.ok(guard, 'post-review must check the artifact ID before downloading');
  assert.equal(guard.if, "needs.review-round.outputs.can_review == 'true'");
  const download = workflow.jobs['post-review'].steps.find(step => step.name === 'Download review output');
  assert.equal(guard.env.ARTIFACT_ID, download.with['artifact-ids'], 'the guard checks the ID the download uses');
  const run = id => spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', guard.run], {
    env: { PATH: process.env.PATH, BASH_ENV: '/dev/null', ARTIFACT_ID: id }, encoding: 'utf8',
  }).status;
  assert.equal(run('4242'), 0);
  for (const id of ['', '0', 'abc', '42,43', '42 ']) assert.notEqual(run(id), 0, JSON.stringify(id));
});

// The CI failure sweep files a recurring-failure issue when one error line repeats across
// unrelated PRs. Open findings are not CI failures, so the review gates must not emit one.
test('review findings never reach the CI failure sweep as an error cause', async () => {
  const { parse } = await import('yaml');
  const { spawnSync } = require('node:child_process');
  const { causesForStep } = require('./failure-diagnostics.cjs');
  const run = (script, env) => spawnSync('bash', ['--noprofile', '--norc', '-eu', '-o', 'pipefail', '-c', script], {
    env: { PATH: process.env.PATH, BASH_ENV: '/dev/null', EVENT_NAME: 'pull_request_target', ...env }, encoding: 'utf8',
  });
  // GitHub renders a ::<level>:: workflow command into the job log as ##[<level>].
  const swept = (result, stepName) => causesForStep({
    run: { id: 1, run_attempt: 1 }, job: { id: 2 }, step: { number: 3, name: stepName },
    log: (result.stdout + result.stderr).replace(/^::(\w+)::/gm, '##[$1]'),
  }).map(cause => cause.kind);

  const review = parse(fs.readFileSync(workflowPath, 'utf8'));
  const [verdict] = review.jobs['review-complete'].steps;
  const passing = {
    VALIDATE_RESULT: 'success', REVIEW_ROUND_RESULT: 'success', CAN_REVIEW: 'true', PROVIDER: 'codex',
    CLAUDE_RESULT: 'skipped', CODEX_RESULT: 'success', POST_RESULT: 'success', NEW_THREADS: '0', OPEN_THREADS: '0',
  };
  for (const findings of [{ NEW_THREADS: '1', OPEN_THREADS: '1' }, { OPEN_THREADS: '2' }]) {
    const result = run(verdict.run, { ...passing, ...findings });
    assert.equal(result.status, 1, 'findings still fail the check');
    assert.deepEqual(swept(result, verdict.name), ['unknown'], JSON.stringify(findings));
  }
  // A broken review is a real failure and stays an error the sweep can group.
  assert.deepEqual(swept(run(verdict.run, { ...passing, NEW_THREADS: '', OPEN_THREADS: '' }), verdict.name), ['error']);

  const ci = parse(fs.readFileSync(ciPath, 'utf8'));
  const [gate] = ci.jobs['review-result'].steps;
  for (const env of [{ VERIFY_RESULT: 'success', REVIEW_RESULT: 'failure' }, { VERIFY_RESULT: 'failure', REVIEW_RESULT: 'skipped' }]) {
    const result = run(gate.run, env);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.deepEqual(swept(result, gate.name), ['unknown'], JSON.stringify(env));
  }
});
