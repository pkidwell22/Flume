import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkspaceController} from '../src/controller.ts';

for (const fail of [false, true]) {
  test(`Home listing refresh preserves unresolved command recovery when list ${fail ? 'fails' : 'succeeds'}`, async () => {
    const controller = new WorkspaceController({
      listProjects: async () => { if (fail) throw new Error('listing unavailable'); return []; },
      getWorkspace: async () => { throw new Error('must not hydrate'); },
      command: async () => { throw new Error('must not mutate'); },
      uploadAsset: async () => { throw new Error('must not upload'); },
    });
    const command = {type:'project.create',commandId:'00000000-0000-4000-8000-000000000001',name:'Pending',brief:''};
    const error = {code:'ACCEPTANCE_UNKNOWN',message:'Check the original request'};
    (controller as any).update({phase:'ready',uncertainCommand:command,error});
    await controller.refreshProjects();
    assert.equal(controller.getSnapshot().uncertainCommand, command);
    assert.equal(controller.getSnapshot().error, error);
    assert.equal(controller.getSnapshot().phase, 'ready');
  });
}
