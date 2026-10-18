import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLocalStore} from './dev-store.mjs';
test('actual root store owner refuses linked pre-existing data without touching its target',async()=>{
 const base=await mkdtemp(join(tmpdir(),'flume-root-link-')),root=join(base,'app'),target=join(base,'target');
 try{
  await mkdir(root);await mkdir(target);await mkdir(join(root,'.flume'));await symlink(target,join(root,'.flume','postgres'));
  await assert.rejects(openLocalStore({root,pgBin:process.env.PG_BIN}),/unowned|symlink/);
  assert.deepEqual(await readdir(target),[]);
 }finally{await rm(base,{recursive:true,force:true});}
});
