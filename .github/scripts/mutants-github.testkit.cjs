'use strict';
// An in-memory Octokit with the calls mutants-comment.cjs makes, for the comment and workflow tests.

const BOT = 'github-actions[bot]';

function fakeGithub({ pulls = [], comments = [] } = {}) {
  const state = { pulls, comments: [...comments], nextId: 100, writes: [], reads: 0 };
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
    },
  };
  return { state, rest, paginate: async (method, params) => (await method(params)).data };
}

module.exports = { fakeGithub, BOT };
