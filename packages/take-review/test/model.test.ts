import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getTakeMedia} from '../src/model';
import {shot,take,asset} from './fixtures';
test('a take is available only through its owned project asset', () => {
  const result = getTakeMedia(shot,take,[asset]);
  assert.equal(result.status, 'ready');
  if(result.status==='ready') { assert.equal(result.asset, asset); assert.equal(result.url,asset.mediaUrl); }
});

test('invalid URL segments are unavailable rather than normalized or thrown', () => {
  for(const id of ['.','..','\ud800']) {
    const candidate={...asset,id,mediaUrl:`/api/media/${id}`};
    assert.equal(getTakeMedia(shot,{...take,assetId:id},[candidate]).status,'unavailable');
  }
});

test('remote URLs, foreign media, wrong shots, and image assets never become playable takes', () => {
  for (const candidate of [
    {...asset, mediaUrl:'https://provider.invalid/received.mp4'},
    {...asset, mediaUrl:'//provider.invalid/received.mp4'},
    {...asset, mediaUrl:'javascript:alert(1)'},
    {...asset, mediaUrl:'/api/media/other'},
    {...asset, projectId:'other-project'},
    {...asset, kind:'image' as const},
  ]) assert.equal(getTakeMedia(shot,take,[candidate]).status,'unavailable');
  assert.equal(getTakeMedia(shot,{...take,shotId:'other-shot'},[asset]).status,'unavailable');
  assert.equal(getTakeMedia(shot,{...take,projectId:'other-project'},[asset]).status,'unavailable');
  assert.equal(getTakeMedia(shot,take,[]).status,'unavailable');
});
