const {createFailureWriter}=require('./failure-issue-writer.cjs');
const {sanitize,hash}=require('./failure-diagnostics.cjs');
const code=text=>sanitize(text).split('\n').map(line=>`    ${line}`).join('\n');
const signatureMarker=signature=>`<!-- cez-failure-signature:v1:${signature} -->`;
const runLink=(base,run)=>`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}`;

function bodyForPattern({cause,signature,occurrence,runUrl,previous}) {
  return `${signature}\n${occurrence}\n\n## Context / Why\n\nAn identifiable CI failure recurred across unrelated changes. The occurrence evidence and sweep summary below describe its scope and uncertainty.\n\n${code(cause.title)}\n\n## What needs to be done\n\nDiagnose the recorded cause, implement a verified repair, and add regression coverage where applicable. A passing retry alone does not prove a flaky test.\n\n## Acceptance Criteria\n\n- [ ] Identify the cause using the linked evidence\n- [ ] Ship a repair with regression coverage or documented verification\n- [ ] Verify the affected workflows succeed\n\n## Related links\n\n- [First failing run](${runUrl})${previous?`\n- [Previous closed report](${previous})`:''}\n\n## Out of scope\n\n- Automatic retries, test quarantine, and unrelated failures\n`;
}
function labelFor(cause,available) {
  const area=/^packages\/(cezar|web|contract|api-client)\//.exec(cause.testFile||'')?.[1];
  const label=area?`area-${area}`:'area-ci';
  return available.has(label)?label:'area-ci';
}
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function identityVariants(value) {
  // Rendering punctuation may be neutralized; lossy credential redaction must
  // never make two otherwise different test names look identical for adoption.
  return [...new Set([value,value.replace(/>/g,'›').replace(/`/g,'ˋ').replace(/@/g,'@\u200b')])];
}
function corroborates(issue,text,pattern,base) {
  if(pattern.cause.kind!=='test' || !pattern.cause.testIdentity?.includes(' > '))return false;
  const file=pattern.cause.testFile,name=pattern.cause.testIdentity.slice(pattern.cause.testIdentity.indexOf(' > ')+3);
  if(!file||file.length>1000||name.length>2000)return false;
  const hasFile=identityVariants(file).some(value=>new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegex(value)}(?=$|[^A-Za-z0-9_./-])`).test(text));
  const hasName=identityVariants(name).some(value=>{
    const escaped=escapeRegex(value);
    const quoted=['`','ˋ','"',"'"].some(quote=>text.includes(quote+value+quote));
    const standalone=new RegExp(`^(?:\\s*[-*]\\s*)?(?:Test:\\s*)?${escaped}\\s*$`,'m').test(text);
    const fullIdentity=identityVariants(file+' > '+name).some(full=>text.split(/\r?\n/).some(line=>line.trim()===full || line.trim()==='FAIL '+full));
    return quoted || standalone || fullIdentity;
  });
  if(!hasFile||!hasName)return false;
  return pattern.occurrences.some(({run,job})=>{
    const urls=[runLink(base,run),`${base}/actions/runs/${run.id}/job/${job.id}`];
    return urls.some(url=>text.split(url).slice(1).some(tail=>!/^\d|^[A-Za-z_/?#]/.test(tail)));
  });
}
function summaryFor(pattern,base,start,end) {
  const marker=`<!-- cez-sweep-summary:v1:${pattern.cause.signature} -->`;
  const identity=hash(JSON.stringify({classification:pattern.classification,failures:pattern.occurrences.map(o=>`${o.run.id}:${o.run.run_attempt}:${o.job.id}:${o.step.number}`).sort(),passes:pattern.comparisons.map(o=>`${o.run.id}:${o.run.run_attempt}:${o.job.id}:${o.step.number}`).sort()}));
  const evidence=`<!-- cez-sweep-evidence:v1:${identity} -->`;
  const workflows=[...new Set(pattern.occurrences.map(o=>o.run.name))].sort();
  const failureLinks=[...new Set(pattern.occurrences.map(o=>runLink(base,o.run)))];
  const comparisons=[...new Set(pattern.comparisons.map(o=>`${runLink(base,o.run)} (job ${o.job.id}, step ${o.step.number})`))];
  const classification=pattern.classification==='possible-test-flakiness'?'Possible test flakiness':'Recurring failure';
  const body=`**Agent context**\n\n${marker}\n${evidence}\n\n${classification}: ${pattern.counts.failures} failure occurrences in ${pattern.counts.runs} runs, ${pattern.counts.shas} commits, and ${pattern.counts.contexts} independent change contexts.\n\nObserved run-creation window: ${start} through ${end}. Counts cover this window, not lifetime totals; passing comparisons are not failures. Partial scan counts are lower bounds when the linked sweep reports incomplete coverage.\n\nAffected workflows (untrusted metadata):\n\n${code(workflows.join('\n'))}\n\nFailure evidence (first 20 of ${failureLinks.length} run attempts):\n${failureLinks.slice(0,20).map(url=>`- [Run attempt](${url})`).join('\n')}\n\nSuccessful unchanged-SHA retry comparisons (first 20 of ${comparisons.length}):\n${comparisons.length?comparisons.slice(0,20).map(text=>`- ${text}`).join('\n'):'None observed.'}\n\nThis evidence does not establish flakiness by itself. A passing retry can reflect runner, dependency, or infrastructure changes; investigate before attributing nondeterminism to the test.\n`;
  return {marker,evidence,body};
}
async function reportPatterns({api,owner,repo,patterns,start,end}) {
  if(!patterns.length||api.stopped)return api.manifest.reports;
  const base={owner,repo},url=`https://github.com/${owner}/${repo}`;
  let writer,initialIssueCount;
  try {
    writer=await createFailureWriter({github:api,...base,maxIssues:api.limits.issues,maxOccurrences:api.limits.occurrences});
    initialIssueCount=writer.issues.length;
    const available=new Set((await api.paginate('GET /repos/{owner}/{repo}/labels',base)).map(label=>label.name));
    // Resolve all potential owners before creating any issue. Partial lookups
    // must never be mistaken for evidence that no remediation report exists.
    const evidence=new Map();
    for(const issue of writer.issues) {
      evidence.set(issue.number,[issue.body||'',...(await writer.commentsFor(issue)).map(c=>c.body||'')].join('\n'));
    }
    for(const pattern of patterns) {
      const marker=signatureMarker(pattern.cause.signature);
      const owners=writer.issues.filter(i=>(i.body||'').includes(marker));
      const openOwners=owners.filter(i=>i.state==='open');
      if(openOwners.length>1) {api.problem('ambiguous-owner');continue;}
      if(!owners.length) {
        const matches=writer.issues.filter(i=>i.state==='open' && corroborates(i,evidence.get(i.number)||'',pattern,url));
        if(matches.length>1) {api.problem('ambiguous-owner');continue;}
        if(matches.length===1) {
          const target=matches[0],body=`${target.body||''}\n\n${marker}`;
          if(body.length>60000) {api.problem('adoption-body-limit',{issueNumber:target.number});continue;}
          await api.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}',{...base,issue_number:target.number,body});
          target.body=body;
        }
      }
      const targets=new Map();
      // Reuse source-step reconciliation even when only a subset of that
      // step's causes meets the sweep's evidence threshold.
      for(const occurrence of pattern.occurrences) {
        const issueCount=writer.issues.length;
        const results=await writer.reportStep({...occurrence,causes:[occurrence.cause],labels:[labelFor(pattern.cause,available)],bodyFor:bodyForPattern});
        api.manifest.reports.issues+=writer.issues.length-issueCount;
        for(const result of results) {
          if(result.reported)api.manifest.reports.occurrences++;
          targets.set(result.issue.number,result.issue);
        }
      }
      const summary=summaryFor(pattern,url,start,end);
      for(const issue of targets.values()) {
        const comments=await writer.commentsFor(issue),previous=comments.find(c=>(c.body||'').includes(summary.marker));
        if(previous?.body.includes(summary.evidence))continue;
        if(previous) {
          await api.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',{...base,comment_id:previous.id,body:summary.body});previous.body=summary.body;
        } else {
          const {data:created}=await api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',{...base,issue_number:issue.number,body:summary.body});comments.push(created);
        }
      }
    }
  } catch(error) {
    const code=['issue-limit','occurrence-limit'].includes(error?.code)?error.code:'reporting-incomplete';
    api.problem(code);
  }
  if(writer && initialIssueCount!==undefined)api.manifest.reports.issues=writer.issues.length-initialIssueCount;
  return api.manifest.reports;
}
module.exports={reportPatterns};
