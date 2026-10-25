import '../../../packages/shot-editor/test/setup.ts';
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {cleanup,render,screen} from '@testing-library/react';
import {AuthoringStoryboard} from '../src/AuthoringWorkspace.tsx';
import {WorkspaceController} from '../src/controller.ts';
import type {Workspace,WorkspaceState} from '../src/types.ts';
afterEach(cleanup);
test('a recovered saved proposal remains editable when the planner is unavailable',()=>{
 const workspace:Workspace={project:{id:'p',name:'Fixture',brief:'',revision:1},shots:[],assets:[],takes:[],attempts:[],reviews:[],exports:[],capabilities:[]};
 const controller=new WorkspaceController({listProjects:async()=>[],getWorkspace:async()=>workspace,command:async()=>{throw new Error('not used');},uploadAsset:async()=>{throw new Error('not used');}});
 const state:WorkspaceState={...controller.getSnapshot(),phase:'ready',workspace,authoring:{phase:'ready',error:null,capabilities:{imageModels:[],storyboard:{available:false,blocker:'Planner offline'}},proposal:{id:'saved-id',revision:2,status:'draft',failure:null,items:[{itemId:'cut',title:'Existing cut',direction:'Existing direction',startDescription:'Start',endDescription:'End',durationSeconds:5,continuityNotes:'',state:'pending',shotId:null}]}}};
 render(<AuthoringStoryboard controller={controller} state={state} workspace={workspace}/>);
 assert.equal((screen.getByRole('button',{name:'Create 1 shots'}) as HTMLButtonElement).disabled,false);
 assert.equal((screen.getByLabelText('Title cut 1') as HTMLInputElement).disabled,false);
});
