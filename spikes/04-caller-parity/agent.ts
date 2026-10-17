// Deterministic headless adapter, NOT an LLM runtime and NOT MCP.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export class AgentClient {
  origin:string; token:string;
  constructor(origin:string,token:string) {assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);this.origin=origin;this.token=token;}
  async request(path:string,command?:unknown) {
    const res=await fetch(this.origin+path,{method:command===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},...(command===undefined?{}:{body:JSON.stringify(command)})});
    const result=await res.json();if(!res.ok) throw new Error(`${res.status} ${result.error}`);return result;
  }
  read(){return this.request('/state');}
  command(command:unknown){return this.request('/commands',command);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [origin,keyFile,commandFile]=process.argv.slice(2);assert(origin&&keyFile&&commandFile,'Usage: agent.ts ORIGIN KEY_FILE read|COMMAND_FILE');
    const client=new AgentClient(origin,(await readFile(keyFile,'utf8')).trim());
    console.log(JSON.stringify(commandFile==='read'?await client.read():await client.command(JSON.parse(await readFile(commandFile,'utf8')))));
  } catch(error){console.error((error as Error).message);process.exitCode=1;}
}
