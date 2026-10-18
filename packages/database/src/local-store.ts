import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,realpath,lstat,readdir,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from './index.ts';
export type LocalStoreOptions={root:string;pgBin?:string;scratch?:string};
/** Persistent app lifecycle. It never removes data and never attaches to an existing server. */
export async function openLocalStore({root:rawRoot,pgBin=process.env.PG_BIN??'/opt/homebrew/bin',scratch=process.env.TMPDIR??tmpdir()}:LocalStoreOptions){
 const root=path.resolve(rawRoot),token=randomUUID(),uid=process.getuid?.();
 if(uid===undefined)throw new Error('POSIX_UID_REQUIRED');
 await mkdir(root,{recursive:true,mode:0o700});
 if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw new Error('STORE_SYMLINK_DENIED');
 const marker=path.join(root,'owner.json'),data=path.join(root,'postgres'),lock=path.join(root,'runtime.lock');
 let owner:{version:number;uid:number;id:string;database:string};
 try{owner=JSON.parse(await readFile(marker,'utf8'));}
 catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  if((await readdir(root)).length)throw new Error('STORE_NOT_OWNED');
  owner={version:1,uid,id:randomUUID(),database:'flume'};
  await writeFile(marker,JSON.stringify(owner),{flag:'wx',mode:0o600});
 }
 if(owner.version!==1||owner.uid!==uid||owner.database!=='flume')throw new Error('STORE_OWNER_MISMATCH');
 try{await writeFile(lock,token,{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('STORE_IN_USE: owned runtime.lock exists; do not start or stop another server.');throw error;}
 let socket:string|undefined,pool:pg.Pool|undefined,started=false,closing:Promise<void>|undefined;
 const run=(name:string,args:string[])=>execFileSync(path.join(pgBin,name),args,{env:{...process.env,LC_ALL:'C'},encoding:'utf8',stdio:'pipe'});
 async function close(){return closing??=(async()=>{
  try{await pool?.end();}finally{
   const current=JSON.parse(await readFile(marker,'utf8'));
   if(current.id!==owner.id||current.uid!==uid||await readFile(lock,'utf8')!==token)throw new Error('STORE_CLOSE_OWNERSHIP_MISMATCH');
   if(started){
    const pid=(await readFile(path.join(data,'postmaster.pid'),'utf8')).split('\n');
    if(pid[1]!==data)throw new Error('STORE_PROCESS_MISMATCH');
    run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
    started=false;
   }
   if(socket)await rm(socket,{recursive:true});
   await rm(lock); // Only the lock successfully acquired by this invocation.
   process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
  }
 })();}
 const onSignal=()=>void close().then(()=>process.exit(130),()=>process.exit(1));
 process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 try{
  const canonicalScratch=await realpath(scratch);
  if(!/^[a-zA-Z0-9_/.-]+$/.test(canonicalScratch))throw new Error('UNSAFE_SOCKET_PATH');
  socket=await mkdtemp(path.join(canonicalScratch,'flp-'));
  if(Buffer.byteLength(path.join(socket,'.s.PGSQL.5432'))>=104)throw new Error('SOCKET_PATH_TOO_LONG');
  // Validate/create the actual owned directory BEFORE initdb can write into it.
  await mkdir(data,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const dataInfo=await lstat(data);
  if(!dataInfo.isDirectory()||dataInfo.isSymbolicLink()||dataInfo.uid!==uid||await realpath(data)!==data)throw new Error('STORE_DATA_SYMLINK_DENIED');
  let initialized=true;
  try{await lstat(path.join(data,'PG_VERSION'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;initialized=false;}
  if(!initialized)run('initdb',['-D',data,'--username=flume_owner','--auth=trust','--encoding=UTF8','--no-locale']);
  if((await lstat(data)).isSymbolicLink()||await realpath(data)!==data)throw new Error('STORE_DATA_SYMLINK_DENIED');
  // No TCP listener. Socket directory is private and short-lived; data is persistent.
  run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-k ${socket} -h '' -p 5432`,'-w','start']);
  started=true;
  const config:pg.PoolConfig={host:socket,port:5432,user:'flume_owner',database:'postgres',max:12,connectionTimeoutMillis:5000,options:'-c statement_timeout=15000 -c lock_timeout=5000'};
  pool=new pg.Pool(config);
  const identity=(await pool.query("SELECT current_setting('data_directory') AS data,current_setting('listen_addresses') AS listen")).rows[0];
  if(identity.data!==data||identity.listen!=='')throw new Error('STORE_DATABASE_IDENTITY_MISMATCH');
  if(!(await pool.query("SELECT 1 FROM pg_database WHERE datname='flume'")).rowCount)await pool.query('CREATE DATABASE flume');
  await pool.end();pool=undefined;
  config.database='flume';pool=new pg.Pool(config);
  await migrate(pool);
  return {pool,root,mediaRoot:path.join(root,'media'),close};
 }catch(error){await close();throw error;}
}
