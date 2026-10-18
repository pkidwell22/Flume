import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openLocalStore} from '../src/local-store.ts';
test('standalone helper rejects a linked data directory before initdb can change its target',async()=>{
 const base=await mkdtemp(join(tmpdir(),'flume-link-')),root=join(base,'store'),target=join(base,'untouched');
 try{
  await mkdir(root,{mode:0o700});await mkdir(target,{mode:0o700});
  await writeFile(join(root,'owner.json'),JSON.stringify({version:1,uid:process.getuid!(),id:randomUUID(),database:'flume'}),{flag:'wx',mode:0o600});
  await symlink(target,join(root,'postgres'));
  await assert.rejects(openLocalStore({root}),/STORE_DATA_SYMLINK_DENIED/);
  assert.deepEqual(await readdir(target),[],'initdb must not initialize the separate target');
  await assert.rejects(stat(join(root,'runtime.lock')),{code:'ENOENT'});
 }finally{await rm(base,{recursive:true,force:true});}
});
