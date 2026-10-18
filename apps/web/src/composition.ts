// Real package adapters. No test components or fixture data in the product entry.
import { createElement, useCallback } from 'react';
import { Brand } from '@flume/ui';
import { ShotEditor } from '@flume/shot-editor';
import { TakeReview } from '@flume/take-review';
import { ActivityPanel, GenerationReview } from '@flume/activity-review';
import type { WorkspaceComponents, ShotEditorProps } from './ports.ts';

function EditorAdapter(props: ShotEditorProps) {
  // Stable callback: the component reports dirty in an effect, so an inline
  // state-writing callback here would create an effect/render feedback loop.
  const dirty = useCallback((value: boolean) => props.onDirtyChange(value), [props.onDirtyChange]);
  return createElement(ShotEditor, {
    shot: props.shot, assets: props.assets, busy: props.busy,
    capabilities: props.capabilities.map(c => ({...c, frameRoles:c.frameRoles.map(role => role==='first'?'first_frame':role==='last'?'last_frame':role)})),
    onDirtyChange: dirty,
    onSave: input => props.onSave({...input.patch, controls:{...input.patch.controls,seed:input.patch.controls.seed??null}},input.expectedRevision),
    onUpload: input => props.onUpload(input.file),
    onPrepare: input => props.onPrepare(input.expectedRevision),
  });
}
export const workspaceComponents: WorkspaceComponents = {
  Brand, ShotEditor: EditorAdapter,
  TakeReview: props => createElement(TakeReview, {...props,
    onInspect: input => props.onInspect(input.takeId),
    onSelect: input => props.onSelect(input.takeId,input.inspectionId),
    onExport: () => props.onExport(),
  }),
  ActivityPanel: props => createElement(ActivityPanel, {...props, assets:[]}),
  GenerationReview: props => createElement(GenerationReview, {...props,
    onApprove: (_id,limits) => props.onApprove(limits),
    onSubmit: () => props.onSubmit(),
  }),
};
