import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const exec=promisify(execFile);
export const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// Internal paths are resolved only from the owned catalog or recovery records.
// No public path/URL input. Keep the original R1 4096-byte intake unchanged.
export async function inspectVideo(path:string, expected:string) {
  const stat=await lstat(path); assert(stat.isFile()&&!stat.isSymbolicLink());
  const bytes=await readFile(path); assert.equal(digest(bytes),expected,'MEDIA_HASH');
  const probe=await exec('/opt/homebrew/bin/ffprobe',['-v','warning','-count_frames','-show_streams','-show_format','-of','json',path]);
  assert.equal(probe.stderr,'');
  const p=JSON.parse(probe.stdout); assert.equal(p.streams.length,1);
  const s=p.streams[0]; assert.equal(s.codec_name,'h264'); assert.equal(s.codec_type,'video');
  assert.equal(s.width,192); assert.equal(s.height,108); assert.equal(Number(s.nb_read_frames),6);
  const decode=await exec('/opt/homebrew/bin/ffmpeg',['-v','warning','-xerror','-i',path,'-f','null','-']);
  assert.equal(decode.stderr,'');
  return {sha256:expected,size:bytes.length,probe:{codec:s.codec_name,width:s.width,height:s.height,
    frames:Number(s.nb_read_frames),timeBase:s.time_base,duration:p.format.duration}};
}
