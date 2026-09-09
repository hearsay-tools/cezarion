import json, subprocess, time, sys
from pathlib import Path
REPO='hearsay-tools/cezarion'
phase=sys.argv[1]
refs=dict(github=f'bench/ci-github-{phase}',blacksmith=f'bench/ci-blacksmith-{phase}')
output_root=Path(sys.argv[2]) if len(sys.argv)>2 else Path('/tmp/cez-provider-results')
root=output_root/phase;root.mkdir(parents=True,exist_ok=False)
def gh(*args):
    return subprocess.check_output(['gh',*args],text=True)
def runs(ref):
    return json.loads(gh('run','list','--repo',REPO,'--workflow','ci.yml','--branch',ref,'--event','workflow_dispatch','--limit','30','--json','databaseId,status,conclusion,headSha,createdAt,updatedAt,url'))
def dispatch(provider,ref,rep):
    old={r['databaseId'] for r in runs(ref)}
    gh('workflow','run','ci.yml','--repo',REPO,'--ref',ref)
    for _ in range(30):
        new=[r for r in runs(ref) if r['databaseId'] not in old]
        if len(new)==1:
            run=new[0];print(json.dumps(dict(event='started',phase=phase,provider=provider,rep=rep,run=run)),flush=True)
            return run['databaseId']
        if len(new)>1: raise RuntimeError('Ambiguous dispatch')
        time.sleep(2)
    raise RuntimeError('Dispatch not found')
records=[]
for rep in (1,2,3):
    ordered=list(refs.items()) if rep%2 else list(reversed(list(refs.items())))
    ids={provider:dispatch(provider,ref,rep) for provider,ref in ordered}
    deadline=time.monotonic()+35*60
    pending=set(ids)
    while pending:
        for provider in list(pending):
            rid=ids[provider];run=json.loads(gh('run','view',str(rid),'--repo',REPO,'--json','databaseId,status,conclusion,headSha,createdAt,updatedAt,url,event,jobs'))
            out=root/f'{provider}-{rep}';out.mkdir(exist_ok=True)
            (out/'run.json').write_text(json.dumps(run,indent=2))
            if run['status']=='completed':
                jobs=json.loads(gh('api',f'repos/{REPO}/actions/runs/{rid}/jobs?per_page=100'))
                (out/'jobs.json').write_text(json.dumps(jobs,indent=2))
                if jobs['total_count']>len(jobs['jobs']): raise RuntimeError('Truncated jobs')
                with (out/'workflow.log').open('w') as log:
                    subprocess.run(['gh','run','view',str(rid),'--repo',REPO,'--log'],stdout=log,check=True)
                record=dict(provider=provider,repetition=rep,runId=rid,headSha=run['headSha'],conclusion=run['conclusion'],createdAt=run['createdAt'],completedAt=run['updatedAt'],url=run['url'])
                records.append(record);(root/'campaign.json').write_text(json.dumps(records,indent=2))
                print(json.dumps(dict(event='completed',**record)),flush=True);pending.remove(provider)
        if pending:
            if time.monotonic()>deadline: raise RuntimeError('Bounded campaign wait exceeded; inspect live runs')
            time.sleep(30)
print(json.dumps(dict(event='campaign-complete',phase=phase,records=records)),flush=True)
