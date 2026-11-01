'use strict';
// An in-memory Octokit with the calls the mutation scripts make, for their script and workflow tests.

const BOT = 'github-actions[bot]';

function fakeGithub({ pulls = [], comments = [], issues = [], runs = [], artifacts = [] } = {}) {
  const state = { pulls, comments: [...comments], issues: issues.map(issue => ({ ...issue })), runs, artifacts, nextId: 100, writes: [], reads: 0, runQueries: [] };
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
        const created = { number, title, body, labels: labels.map(name => ({ name })), state: 'open', user: { login: BOT }, html_url: `https://github.test/issues/${number}` };
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
      // Pages like the REST API: per_page (default 30) and page (from 1).
      listWorkflowRuns: async ({ owner: _owner, repo: _repo, per_page: perPage = 30, page = 1, ...query } = {}) => {
        state.reads += 1;
        state.runQueries.push(query);
        return { data: { total_count: state.runs.length, workflow_runs: state.runs.slice((page - 1) * perPage, page * perPage) } };
      },
      listWorkflowRunArtifacts: async ({ run_id, name }) => ({ data: { artifacts: state.artifacts.filter(a => a.run_id === run_id && (!name || a.name === name)) } }),
      downloadArtifact: async ({ artifact_id }) => { state.reads += 1; return { data: state.artifacts.find(a => a.id === artifact_id).data }; },
    },
  };
  // Octokit's paginate flattens a namespaced list such as workflow_runs across every page.
  const paginate = async (method, params) => {
    const first = (await method(params)).data;
    if (!Array.isArray(first?.workflow_runs)) return first;
    const all = [...first.workflow_runs];
    for (let page = 2; all.length < first.total_count; page++) all.push(...(await method({ ...params, page })).data.workflow_runs);
    return all;
  };
  return { state, rest, paginate };
}

module.exports = { fakeGithub, BOT };
