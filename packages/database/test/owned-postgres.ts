import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Test-only acquisition. Never accepts a supplied database URL/data directory. */
export async function ownedPostgres() {
  const scratch = await realpath(process.env.TMPDIR ?? tmpdir());
  // Approval must name the canonical scratch parent, not a supplied database/data directory.
  assert(process.env.FLUME_TEST_SCRATCH_ALLOWED === scratch,
    'Use explicitly owned test scratch: set FLUME_TEST_SCRATCH_ALLOWED to the canonical TMPDIR');
  const root = await mkdtemp(path.join(scratch, 'fs-'));
  const data = path.join(root, 'd'), socket = path.join(root, 's');
  const owner = randomUUID(), bin = process.env.PG_BIN ?? '/opt/homebrew/bin';
  const env = {...process.env, LC_ALL:'C'};
  let pool:pg.Pool | undefined, started = false, stopping:Promise<void> | undefined;
  const run = (name:string,args:string[]) => execFileSync(path.join(bin,name),args,{env,encoding:'utf8',stdio:'pipe'});
  const close = () => stopping ??= (async()=>{
    if (pool) await pool.end();
    const marker=JSON.parse(await readFile(path.join(root,'owner.json'),'utf8'));
    assert.equal(marker.owner,owner); assert.equal(marker.uid,process.getuid!());
    if(started) {
      const pidLines=(await readFile(path.join(data,'postmaster.pid'),'utf8')).split('\n');
      assert.equal(pidLines[1],data); const pid=Number(pidLines[0]);
      run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
      assert.throws(()=>process.kill(pid,0), {code:'ESRCH'});
    }
    await rm(root,{recursive:true});
    await assert.rejects(stat(root),{code:'ENOENT'});
    process.removeListener('SIGINT',onSignal); process.removeListener('SIGTERM',onSignal);
    console.log('owned PostgreSQL stopped and removed', path.basename(root));
  })();
  const onSignal=()=>void close().finally(()=>process.exit(130));
  await writeFile(path.join(root,'owner.json'),JSON.stringify({owner,uid:process.getuid!()}),{flag:'wx',mode:0o600});
  process.once('SIGINT',onSignal); process.once('SIGTERM',onSignal);
  try {
    await mkdir(socket,{mode:0o700});
    assert(Buffer.byteLength(path.join(socket,'.s.PGSQL.5432'))<104);
    run('initdb',['-D',data,'--username=flume_test','--auth=trust','--encoding=UTF8','--no-locale']);
    run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-o',`-k ${socket} -h '' -p 5432 -F`,'-w','start']);
    started=true;
    const config:pg.PoolConfig={host:socket,port:5432,user:'flume_test',database:'postgres',max:8,connectionTimeoutMillis:5000,options:'-c statement_timeout=10000 -c lock_timeout=5000'};
    pool=new pg.Pool(config);
    const identity=(await pool.query(`select current_setting('data_directory') as data, current_setting('listen_addresses') as listen`)).rows[0];
    assert.equal(identity.data,data); assert.equal(identity.listen,'');
    await pool.query('CREATE DATABASE flume_test'); await pool.end();
    config.database='flume_test'; pool=new pg.Pool(config);
    assert.equal((await pool.query('select current_database() as name')).rows[0].name,'flume_test');
    return {pool,config,root,close};
  } catch(error) {await close();throw error;}
}
