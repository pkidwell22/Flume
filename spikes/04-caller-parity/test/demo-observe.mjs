// Test-only observer loaded into the actual demo process. It never substitutes
// resources or reads session keys; collect ownership before startup can fail.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const listen=http.Server.prototype.listen;
http.Server.prototype.listen=function(...args) {
  this.once('listening',()=>{
    const address=this.address(),data=process.env.SPIKE_DATA_DIRECTORY;
    if(!data||!address||typeof address==='string')throw new Error('OWNERSHIP_OBSERVATION_MISSING');
    const pgPid=Number(readFileSync(path.join(data,'postmaster.pid'),'utf8').split('\n')[0]);
    process.send({observation:'owned-listener',origin:`http://127.0.0.1:${address.port}`,root:path.dirname(data),pgPid});
  });
  return listen.apply(this,args);
};
