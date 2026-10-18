import {build} from 'esbuild';
import {createServer} from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,mkdir,mkdtemp,writeFile,stat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const electron=process.env.FLUME_TEST_ELECTRON;
if(!electron) throw new Error('Set FLUME_TEST_ELECTRON to an already installed, unpackaged Electron executable. No install is attempted.');
await stat(electron);
const results=join(root,'test-results/native');await mkdir(results,{recursive:true});
const output=await mkdtemp(join(results,'run-'));
const cleanEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'};
for(const [name,filter] of [['a','null'],['b','hflip']]) {
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=24','-vf',filter,'-t','3','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',join(output,`${name}.mp4`)],{encoding:'utf8',env:cleanEnv,timeout:20000});
  if(generated.status!==0) throw new Error(generated.stderr || 'Fixture creation failed');
}
const a=await readFile(join(output,'a.mp4'));const b=await readFile(join(output,'b.mp4'));
const hashes={a:createHash('sha256').update(a).digest('hex'),b:createHash('sha256').update(b).digest('hex')};
await build({entryPoints:[join(here,'fixture.tsx')],bundle:true,outfile:join(output,'fixture.js'),platform:'browser',format:'esm',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TakeReview isolated component test</title><link rel="stylesheet" href="/fixture.css"><style>body{margin:0;background:#f3f4f4}main{max-width:1180px;margin:auto;padding:32px 24px}.fixture-header{font:16px 'Helvetica Neue',sans-serif;display:flex;justify-content:space-between;align-items:center;margin-bottom:32px;color:#626a67;gap:24px}.fixture-header span{font-size:24px;letter-spacing:-1px;color:#212724;font-weight:600}.fixture-header p{margin:0}</style><div id="root"></div><script>window.fixtureHashes=${JSON.stringify(hashes)}</script><script type="module" src="/fixture.js"></script></html>`;
const server=createServer(async(req,res)=>{
  try {
    const media={'/api/media/asset-a':a,'/api/media/asset-b':b,'/api/media/output-a':a}[req.url];
    if(media) {
      const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
      if(match) {
        const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),media.length-1):media.length-1;
        if(start> end || start>=media.length){res.writeHead(416,{'Content-Range':`bytes */${media.length}`});res.end();return;}
        res.writeHead(206,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${media.length}`,'Content-Length':end-start+1});res.end(media.subarray(start,end+1));return;
      }
      res.writeHead(200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':media.length});res.end(media);return;
    }
    if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(html);return;}
    if(['/fixture.js','/fixture.css'].includes(req.url)){res.writeHead(200,{'Content-Type':req.url.endsWith('.css')?'text/css':'text/javascript'});res.end(await readFile(join(output,req.url.slice(1))));return;}
    res.writeHead(404);res.end('Not found');
  } catch {res.writeHead(500);res.end('Fixture server failure');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
let child;
try {
  const response=await fetch(`${url}/api/media/output-a`);const bytes=Buffer.from(await response.arrayBuffer());
  if(createHash('sha256').update(bytes).digest('hex')!==hashes.a)throw new Error('Frozen sample bytes changed');
  await writeFile(join(output,'downloaded-frozen.mp4'),bytes);
  const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,nb_frames','-of','json',join(output,'downloaded-frozen.mp4')],{encoding:'utf8',env:cleanEnv,timeout:10000});
  if(probe.status!==0)throw new Error(probe.stderr);
  await writeFile(join(output,'fixture-probe.json'),probe.stdout);
  child=spawn(electron,[join(here,'witness.cjs'),url,output],{env:cleanEnv,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{log+=chunk;process.stderr.write(chunk);});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),60000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timeout);
  await writeFile(join(output,'witness.log'),log);
  console.log(`Evidence: ${output}`);
  if(code!==0)process.exitCode=1;
} finally {
  if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
