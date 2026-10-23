import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {verifyNativeRgbFrame} from '../src/index.ts';

test('native RGB verification rejects a wrong selected frame and a tampered inspection hash',()=>{
 const selected=Buffer.from('native-rgb-frame-7'),wrong=Buffer.from('native-rgb-frame-8');
 const expected=createHash('sha256').update(selected).digest('hex');
 assert.doesNotThrow(()=>verifyNativeRgbFrame(selected,expected));
 assert.throws(()=>verifyNativeRgbFrame(wrong,expected),{code:'FRAME_RGB_MISMATCH'});
 assert.throws(()=>verifyNativeRgbFrame(selected,'0'.repeat(64)),{code:'FRAME_RGB_MISMATCH'});
});
