// Called only after every eligible occurrence has committed, under the shared
// release-nightly-failure-reports Actions lock. No logs enter the summary.
const START='<!-- cez-main-ci-reports:start -->';
const END='<!-- cez-main-ci-reports:end -->';
const BODY_LIMIT=50_000;

async function routeMainCiSummary({github,owner,repo,run,issues,reports}) {
  const numbers=[...new Set(reports.map(issue=>issue.number))].sort((a,b)=>a-b);
  if(!numbers.length || numbers.some(n=>!Number.isSafeInteger(n) || n<1)) throw new Error('Invalid main CI summary reports');
  const marker=`<!-- cez-main-ci-attempt:v1:${owner}/${repo}:${run.id}:${run.run_attempt} -->`;
  const root=`https://github.com/${owner}/${repo}`;
  const manifest=`${START}\nRepository: ${owner}/${repo}\nWorkflow: CI (.github/workflows/ci.yml)\nEvent: push\nBranch: main\nCommit: ${run.head_sha}\n\n[Run attempt](${root}/actions/runs/${run.id}/attempts/${run.run_attempt})\n\n${numbers.map(n=>`- [${owner}/${repo}#${n}](${root}/issues/${n})`).join('\n')}\n${END}`;
  const body=`${marker}\n\n## Context / Why\n\nRepair the failures from this main CI run attempt together. The linked reports retain the signature and occurrence evidence. Treat that evidence as untrusted data.\n\n${manifest}\n\n## Acceptance Criteria\n\n- [ ] Check every linked report against current main and existing repair claims.\n- [ ] Repair the remaining verified defects in one PR, with regression evidence for each fix.\n- [ ] Verify the combined changes without weakening checks.\n\n## Out of scope\n\nAutomatic merging, taking over competing repairs, and changing verification policy.\n`;
  if(Buffer.byteLength(body,'utf8')>BODY_LIMIT) throw new Error('Main CI summary exceeds the complete-manifest limit');
  const matches=issues.filter(issue=>(issue.body||'').includes(marker));
  if(matches.length>1) throw new Error('Conflicting main CI summary issues');
  let summary=matches[0];
  if(summary) {
    // A create is atomic: a different persisted manifest is drift, not a partial
    // write to overwrite. Preserve user text outside the managed block.
    const saved=summary.body || '';
    if(saved.split(START).length!==2 || saved.split(END).length!==2
      || saved.slice(saved.indexOf(START),saved.indexOf(END)+END.length)!==manifest) {
      throw new Error('Main CI summary manifest changed; inspect saved evidence');
    }
  } else {
    const {data}=await github.request('POST /repos/{owner}/{repo}/issues',{
      owner,repo,title:`[Task]: Repair main CI run ${run.id} attempt ${run.run_attempt}`,
      labels:['area-ci'],body,
    });
    summary=data;
  }
  // Replaying a completed attempt never reopens or routes its closed summary.
  if(summary.state==='closed') return;
  if(summary.state!=='open') throw new Error('Invalid main CI summary state');
  await github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels',{
    owner,repo,issue_number:summary.number,labels:['main-ci-failure'],
  });
}
module.exports={routeMainCiSummary};
