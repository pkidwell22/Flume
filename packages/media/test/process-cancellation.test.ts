import assert from 'node:assert/strict';
import test from 'node:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {cancelMediaProcesses} from '../src/index.ts';
import {run} from '../src/process.ts';
import {DEFAULT_LIMITS} from '../src/types.ts';
import {fixture} from './support.ts';

test('worker-isolate cancellation is sticky and prevents every later native spawn',async t=>{
 const f=await fixture(t),marker=join(f.dir,'spawned-after-cancel');
 await cancelMediaProcesses();
 await assert.rejects(run('/bin/sh',['-c',`touch "$1"`,'sh',marker],DEFAULT_LIMITS,f.dir),{code:'PROCESS_CANCELLED'});
 await assert.rejects(stat(marker),{code:'ENOENT'});
});
