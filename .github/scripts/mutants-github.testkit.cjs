'use strict';
// An in-memory Octokit with the calls the mutation scripts make, for their script and workflow tests.

const BOT = 'github-actions[bot]';

function fakeGithub({ pulls = [], comments = [], issues = [], runs = [], artifacts = [] } = {}) {
  const state = { pulls, comments: [...comments], issues: issues.map(issue => ({ ...issue })), runs, artifacts, nextId: 100, writes: [], reads: 0 };
  const issue = number => state.issues.find(item => item.number === number);
  const rest = {
    pulls: { get: async ({ pull_number }) => { state.reads += 1; return { data: state.pulls.find(p => p.number === pull_number) }; } },
    repos: { listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => { state.reads += 1; return { data: state.pulls.filter(p => p.head.sha === commit_sha) }; } },
    issues: {
      listComments: async ({ issue_number }) => ({ data: state.comments.filter(c => c.issue_number === issue_number) }),
      createComment: async ({ issue_number, body }) => {
        const comment = { id: state.nextId++, issue_number, body, user: { login: BOT } };
        state.comments.push(comment);
        state.writes.push('create');
        return { data: comment };
      },
      updateComment: async ({ comment_id, body }) => {
        state.comments.find(c => c.id === comment_id).body = body;
        state.writes.push('update');
        return { data: {} };
      },
      listForRepo: async ({ state: wanted = 'open' }) => ({ data: state.issues.filter(item => wanted === 'all' || item.state === wanted) }),
      create: async ({ title, body, labels = [] }) => {
        const number = state.nextId++;
        const created = { number, title, body, labels: labels.map(name => ({ name })), state: 'open', html_url: `https://github.test/issues/${number}` };
        state.issues.push(created);
        state.writes.push('issue.create');
        return { data: created };
      },
      update: async ({ issue_number, owner: _owner, repo: _repo, ...fields }) => {
        Object.assign(issue(issue_number), fields);
        state.writes.push('issue.update');
        return { data: issue(issue_number) };
      },
    },
    actions: {
      listWorkflowRuns: async () => { state.reads += 1; return { data: { workflow_runs: state.runs } }; },
      listWorkflowRunArtifacts: async ({ run_id, name }) => ({ data: { artifacts: state.artifacts.filter(a => a.run_id === run_id && (!name || a.name === name)) } }),
      downloadArtifact: async ({ artifact_id }) => { state.reads += 1; return { data: state.artifacts.find(a => a.id === artifact_id).data }; },
    },
  };
  return { state, rest, paginate: async (method, params) => (await method(params)).data };
}

module.exports = { fakeGithub, BOT };
