// Negative controls of already-green coverage; never mutate the authored source.
import {cp,mkdir,mkdtemp,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=join(root,'test-results/mutations');await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(out,'run-'));
const mutations=[
  {name:'revision-scope',file:'src/TakeReview.tsx',old:'shot.projectId, shot.id, shot.revision, shot.selectionRevision',value:'shot.projectId, shot.id',test:'guards.test.tsx',pattern:'shot, selection, and source'},
  {name:'asset-identity',file:'src/TakeReview.tsx',old:'take.id, take.assetId, asset?.sha256, asset?.mediaUrl, asset?.kind',value:'take.id, take.assetId',test:'guards.test.tsx',pattern:'shot, selection, and source'},
  {name:'stale-export',file:'src/ExportShelf.tsx',old:'item.stale || item.shotRevision !== shot.revision || item.selectionRevision !== shot.selectionRevision || item.takeId !== shot.selectedTakeId',value:'item.stale',test:'guards.test.tsx',pattern:'staleness is checked'},
  {name:'frozen-source',file:'src/ExportShelf.tsx',old:'take.id === item.takeId',value:'take.id === shot.selectedTakeId',test:'review.test.tsx',pattern:'export is explicit'},
  {name:'playback-gate',file:'src/TakeReview.tsx',old:"media.status === 'ready' && loaded && played && !failed",value:"media.status === 'ready' && !failed",test:'review.test.tsx',pattern:'selection requires playback'},
  {name:'owned-only',file:'src/model.ts',old:'return asset.mediaUrl === expected ? expected : null;',value:'return asset.mediaUrl;',test:'model.test.ts',pattern:'remote URLs'},
  {name:'origin-preservation',file:'src/TakeReview.tsx',old:"sample:'Sample',imported:'Imported',generated:'Generated'",value:"sample:'Generated',imported:'Generated',generated:'Generated'",test:'guards.test.tsx',pattern:'origins and literal'},
  {name:'duplicate-clicks',file:'src/TakeReview.tsx',old:'if (busy || lock.current) return;',value:'if (busy) return;',test:'guards.test.tsx',pattern:'synchronous double clicks'},
];
for(const mutation of mutations){
  const target=join(directory,mutation.name);await mkdir(target);
  for(const file of ['src','test','package.json','tsconfig.json']) await cp(join(root,file),join(target,file),{recursive:true});
  await symlink(await realpath(join(root,'node_modules')),join(target,'node_modules'),'dir');
  const source=await readFile(join(target,mutation.file),'utf8');assert.equal(source.split(mutation.old).length,2,'mutation must match once');
  await writeFile(join(target,mutation.file),source.replace(mutation.old,mutation.value));
  const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1',`--test-name-pattern=${mutation.pattern}`,`test/${mutation.test}`],{cwd:target,encoding:'utf8',timeout:15000});
  const log=result.stdout+result.stderr;await writeFile(join(target,'result.log'),log);
  assert.equal(result.status,1,`${mutation.name} must fail on the intended assertion, not timeout or pass`);
  assert.match(log,/AssertionError/);assert.doesNotMatch(log,/ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError/);
  console.log(`REJECTED ${mutation.name}`);
}
console.log(`All ${mutations.length} negative controls rejected. Evidence: ${directory}`);
