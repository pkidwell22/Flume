/**
 * Storyboard composer contracts — the type-only half of `StoryboardComposer.tsx`.
 *
 * These shapes cross the web surface boundary: the workspace controller, the authoring
 * adapter and, in the server's cross-surface contract test, `apps/server` all read them.
 * They therefore live in a plain `.ts` module so a type-only import never drags a `.tsx`
 * component (and its JSX/React requirements) into a project that does not compile JSX.
 * The component re-exports them, so existing import sites are unchanged.
 *
 * Nothing here is runtime code: the bounds value and the component stay in the `.tsx`.
 */

export type ComposerBounds = { minSeconds: number; maxSeconds: number; maxShots: number; maxTotalSeconds: number };
export type ComposerItemState = 'pending' | 'created' | 'failed' | 'unknown';
export type ComposerStatus = 'draft' | 'applying' | 'applied' | 'partial' | 'unknown' | 'cancelled';

export type ComposerItem = {
  itemId: string;
  title: string;
  direction: string;
  startDescription: string;
  endDescription: string;
  durationSeconds: number;
  continuityNotes: string;
  state: ComposerItemState;
  shotId: string | null;
};
/** The editable half of a cut. State and shotId are server facts, never authored here. */
export type ComposerItemInput = Omit<ComposerItem, 'state' | 'shotId'>;
export type ComposerProposal = {
  id: string;
  status: ComposerStatus;
  revision: number;
  items: ComposerItem[];
  failure: { itemId: string; code: string; message: string } | null;
};
