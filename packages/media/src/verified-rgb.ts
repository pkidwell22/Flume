import {createHash} from 'node:crypto';
import {check} from './types.ts';

/** Verifies native-resolution rgb24 bytes against the decoder inspection identity. */
export function verifyNativeRgbFrame(bytes:Uint8Array,expectedSha256:string){
 check(createHash('sha256').update(bytes).digest('hex')===expectedSha256,'FRAME_RGB_MISMATCH');
}
