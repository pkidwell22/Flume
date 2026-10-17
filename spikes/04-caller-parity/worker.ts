import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Policy } from '../01-approved-attempt/dist/recovery/engine.js';
// Run the proven worker unchanged; it connects with initialize:false.
export function launchWorker(policy:Policy, pause='') {
  const child=fork(new URL('../01-approved-attempt/dist/recovery/worker.js',import.meta.url),[JSON.stringify(policy),pause],{silent:true});
  assert(child.pid); const pid=child.pid;
  const events=new EventEmitter(); const points=new Set<string>(); let result:string|undefined, logs='';
  child.stdout!.on('data',b=>{logs+=b;});child.stderr!.on('data',b=>{logs+=b;});
  child.on('message',(m:any)=>{if(m.point){points.add(m.point);events.emit(m.point);} if(m.result) result=m.result;});
  const exit=new Promise<[number|null,NodeJS.Signals|null]>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{resolve([code,signal]);events.emit('exit');});});
  const done=exit.then(([code,signal])=>{if(code!==0) throw new Error(`WORKER_EXIT ${signal??code}: ${logs}`);return result;});
  void done.catch(()=>{}); // Expected SIGKILL is observed through stop(), not an unhandled rejection.
  return {pid,done,
    async point(name:string){
      if(points.has(name)) return;
      if(child.exitCode!==null||child.signalCode!==null) throw new Error(`WORKER_EXIT: ${logs}`);
      await new Promise<void>((resolve,reject)=>{
        const finish=(error?:Error)=>{clearTimeout(timer);events.off(name,yes);events.off('exit',no);error?reject(error):resolve();};
        const yes=()=>finish(), no=()=>finish(new Error(`WORKER_EXIT: ${logs}`));
        const timer=setTimeout(()=>finish(new Error('CHECKPOINT_TIMEOUT')),10000);
        events.once(name,yes);events.once('exit',no);
      });
    },
    async stop(){if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');await exit;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});},
  };
}
