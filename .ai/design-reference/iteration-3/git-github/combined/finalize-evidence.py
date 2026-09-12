import datetime,hashlib,json,pathlib,subprocess,urllib.request
out=pathlib.Path(__file__).parent.resolve()
composition=json.loads((out.parent/'combined-source-proof.json').read_text())
root=pathlib.Path(composition['snapshotPath'])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
build=root/'packages/cezar/web/dist'
files={str(p.relative_to(build)):sha(p) for p in sorted(build.rglob('*')) if p.is_file()}
buildHash=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
sourceHash=sha(root/'cezarion.pen')
assert sourceHash=='56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8'
served=urllib.request.urlopen('http://127.0.0.1:44663/').read()
assert hashlib.sha256(served).hexdigest()==files['index.html']
notes={
'6':'Preserves the real hierarchical changed-file tree, line-numbered structured diff, full file patches and wrap control. Reference flattens the tree and abbreviates patches. Mobile retains the existing unified/wrapped mode, so source split controls differ. Fixture has 3 changed files rather than the source summary of 9.',
'7':'Search, exact commit links, author/time metadata and SHA labels remain. Source displays PR numbers and an older-commits action; the current repo log API has neither PR association nor pagination. Extra metadata makes rows taller, especially on mobile.',
'8':'Two-panel desktop and stacked mobile layout, 44px controls and purple current chip compared. Empty branch name correctly disables Create; source shows it enabled. Actual unset base remains Follow checked-out branch; source selects main. Mobile retains extra vertical row spacing.',
'9':'List/divider/selection, 22px detail title, prompt inset and external handoff actions compared. Preserves real author/time/comment metadata, activity, filters and utility actions. No fabricated Open state, PR-assignee/board filter, or sync timestamp. Handoff uses actual available model/workflow/account choices and existing Run agent wording; source uses preset Fable/dev-flow/code-review and Start task. These additions make the document taller.',
'14':'Task header and toolbar include parent shared implementation 4d7723df. Preserves full task-attributed diff, hierarchical tree and all Git actions. Source abbreviates diff, relocates toolbar below it, and shows four files while this fixture carries three. Mobile retains automatic unified/wrapped behavior.',
'15':'Card heading, 22px commit subject, filled commit icon, gold View changes and 44px changed-file rows compared. Preserves commit search and author/time/SHA. PR references remain in the shared task header; no commit-to-PR association is invented. Source shows four changed files and its reference badge/action; fixture has three task-changed files.',
'16':'Lazy tree, folder chevrons, exact file-search glyph and centered selection state compared. Real direct-path Open file control remains; source shows Find and Open worktree. Shared task header and available worktree actions differ. Preview/error states are in the interaction manifest.',
'27A':'Ready state verified from a schema-valid parent fixture. Retains exact reviewed SHA, per-check results, refresh and real handoff below readiness. Source abbreviates those details and omits the composer. PR-specific assignee/board/state filters absent from API are not invented.',
'27B':'Blocked/review-required state compared. Source board combines mutually exclusive blocked, confirmation and conflicting states; runtime captures them separately in interaction-manifest.json. Exact-head confirmation is a modal; it never coexists as an inline decorative card. All bypass/conflict gates remain.',
'27C':'Passing check with unknown requirements stays blocked; actual canOverride=false hides bypass. Source shows a bypass control for its different capability fixture. Exact SHA, review/check details and refresh remain; no merge permission inferred from passing CI.',
'R2':'Actual persisted list widths 280/360/520px captured in both themes. Same GitHub document/control differences as family 9; source and runtime share CSS viewport with the parent shared shell included.'}
common='Combined QA snapshot includes parent 4d7723df shell/task headers plus worker 901f75af owned routes. Poppins and exact source glyphs are present. Populated fixture has four tasks and one project; reference has more projects/pinned tasks. Actual worker/status controls and preserved metadata add height. Remaining differences are explicit, not a whole-screen match claim.'
m=json.loads((out/'manifest.json').read_text())
assert len(m['pairs'])==44 and len({r['frameId'] for r in m['pairs']})==44
for r in m['pairs']:
 key=r['frame'].split('.')[0]
 family=key if key.startswith('27') or key=='R2' else key[:-1]
 assert r['observed']['theme']==r['theme']
 r.update(sourceSha256=sourceHash,sourceCommit=commit,webDistSha256=buildHash,fixture='populated-mocks.json',designSha256=sha(out/r['design']),browserSha256=sha(out/r['browser']),verdict='visually reviewed; differences remain',notes=[notes[family],common],comparison='Actual exported 2x design PNG and actual built-browser 1x PNG at identical CSS viewport; images normalized only in contact sheets.')
m.update(sourceSha256=sourceHash,buildCommit=commit,webDistSha256=buildHash,reviewedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),status='combined implementation visually reviewed; documented differences remain')
(out/'manifest.json').write_text(json.dumps(m,indent=2))
for filename in ['interaction-manifest.json','menu-manifest.json']:
 rows=json.loads((out/filename).read_text())
 for r in rows:
  r.update(sourceSha256=sourceHash,sourceCommit=commit,webDistSha256=buildHash,fixture='populated-mocks.json',designSha256=sha(out/r['design']),browserSha256=sha(out/r['browser']),verdict='visually reviewed; contextual source comparison',notes=['Reference frame supplies the surrounding layout. Dialog/menu/file-preview state is a separate live state, not a claim of whole-board pixel equality.',common])
 (out/filename).write_text(json.dumps(rows,indent=2))
proof={'sourceSha256':sourceHash,'buildCommit':commit,'webDistSha256':buildHash,'webAssets':files,'servedIndexSha256':hashlib.sha256(served).hexdigest(),'serverEntrySha256':sha(root/'packages/cezar/dist/index.js'),'baseUrl':'http://127.0.0.1:44663','composition':composition,'pairedFrames':44,'interactionCaptures':24,'menuCaptures':8,'credentials':'Isolated dry-run server inherits only PATH and explicit fixture flags. No real GitHub writes, task launches, branch switches, commits or merge submissions.'}
(out/'build-proof.json').write_text(json.dumps(proof,indent=2))
print(json.dumps({k:v for k,v in proof.items() if k!='webAssets'},indent=2))
