import type { Command, CommandIntent, FlumePort, Receipt, ShotPatch, Workspace, WorkspaceError, WorkspaceState } from './types.ts';
import type { AuthoringPort } from './authoring-api.ts';
import type { ComposerItemInput, ComposerProposal } from './StoryboardComposer.tsx';
import type { ContinueShotOutcome, ContinueShotPublicView, ContinueShotRequest } from './ContinueShot.tsx';
import type { FrameAuthoringDraft, FrameBindInput, FrameBindingReceipt, FrameInspection, FrameReview, FrameSubmission } from './frame-authoring-types.ts';

export interface ProposalBookmarks {
  read(projectId: string): string | null;
  write(projectId: string, proposalId: string | null): void;
}

/** Browser storage for the continuation operation identity only. Never creative content or state. */
export interface ContinuationBookmarks {
  read(projectId: string): string | null;
  write(projectId: string, operationId: string | null): void;
}

export class WorkspaceController {
  private api: FlumePort;
  private state: WorkspaceState = { phase: 'idle', projects: [], workspace: null, activeShotId: null, busy: null, error: null, notice: null, reviewId: null, uncertainCommand: null, dirtyShotIds: new Set(), authoring: { phase: 'idle', capabilities: null, error: null, proposal: null } };
  private authoring: AuthoringPort | null = null;
  private proposalBookmarks: ProposalBookmarks | null;
  private continuationBookmarks: ContinuationBookmarks | null;
  constructor(api: FlumePort, authoring: AuthoringPort | null = null, proposalBookmarks: ProposalBookmarks | null = null, continuationBookmarks: ContinuationBookmarks | null = null) {
    this.api = api; this.authoring = authoring; this.proposalBookmarks = proposalBookmarks;
    this.continuationBookmarks = continuationBookmarks;
  }
  getSnapshot = () => this.state;
  private navigation = 0;
  /**
   * Epoch of the navigation that owns the current busy label, or null when no restore owns it.
   * Recording the owner (rather than comparing label strings) is what lets a later navigation
   * release a superseded restore and stops a late response from clearing a newer operation's label.
   */
  private busyNavigation: number | null = null;
  private beginNavigationBusy(label: string, epoch: number) {
    this.busyNavigation = epoch;
    this.update({ busy: label });
  }
  /** Clear the label only while this exact restore still owns it. */
  private releaseNavigationBusy(epoch: number) {
    if (this.busyNavigation !== epoch) return;
    this.busyNavigation = null;
    this.update({ busy: null });
  }
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WorkspaceState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private editVersions = new Map<string, number>();
  markDirty(shotId: string) {
    this.editVersions.set(shotId, (this.editVersions.get(shotId) ?? 0) + 1);
    this.update({ dirtyShotIds: new Set([...this.state.dirtyShotIds, shotId]) });
  }
  private requireShot(shotId: string) {
    const shot = this.state.workspace?.shots.find(item => item.id === shotId);
    if (!shot) throw new Error('Open this shot before editing it.');
    return shot;
  }
  private applyWorkspace(workspace: Workspace) {
    this.pruneInspections(workspace);
    const activeShotId = workspace.shots.some(shot => shot.id === this.state.activeShotId) ? this.state.activeShotId : workspace.shots[0]?.id ?? null;
    this.update({ workspace, activeShotId, phase: 'ready' });
  }
  private readVersion = 0;
  private errorOf(error: unknown): WorkspaceError {
    const source = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    return { code: typeof source.code === 'string' ? source.code : 'CONNECTION_LOST',
      message: typeof source.message === 'string' ? source.message : 'Could not reach Flume. Check the local service, then try again.',
      ...(typeof source.currentRevision === 'number' ? { currentRevision: source.currentRevision } : {}) };
  }
  private async execute(intent: CommandIntent, replay?: Command): Promise<Receipt> {
    if (this.state.busy) throw new Error('Wait for the current action to finish.');
    if (this.state.uncertainCommand && !replay) throw new Error('Resolve the previous request before starting another action.');
    const command = replay ?? { ...structuredClone(intent), commandId: crypto.randomUUID() } as Command;
    const navigation = this.navigation;
    ++this.readVersion; // A pre-write refresh must never replace a post-write snapshot.
    this.busyNavigation = null; // a command, not a navigation restore, owns the label now
    this.update({ busy: intent.type, error: null, notice: null });
    let accepted: Receipt | null = null;
    try {
      const receipt = await this.api.command(command);
      if (receipt.commandId !== command.commandId || 'projectId' in command && receipt.projectId !== command.projectId) throw new TypeError('The returned receipt does not match this request. Check the original request before continuing.');
      accepted = receipt;
      if (command.type === 'generation.submit') this.submitted.add(command.reviewId);
      this.update({ uncertainCommand: null });
      const readVersion = ++this.readVersion;
      const workspace = await this.api.getWorkspace(receipt.projectId);
      if (navigation === this.navigation && readVersion === this.readVersion) this.applyWorkspace(workspace);
      return receipt;
    } catch (error) {
      const issue = this.errorOf(error);
      if (accepted) {
        this.update({ error: { code: 'READBACK_FAILED', message: 'The action was accepted, but its saved state could not be loaded. Refresh to check it; do not submit it again.' } });
        // A failed GET cannot revoke an accepted save's base revision. Return
        // that receipt to the editor while retaining the readback warning.
        if (command.type === 'shot.update') return accepted;
      } else {
        const status = (error as { status?: number } | null)?.status;
        const outcomeUnknown = error !== null && typeof error === 'object' && 'outcomeUnknown' in error && error.outcomeUnknown === true;
        const uncertain = outcomeUnknown || !status && issue.code === 'CONNECTION_LOST' || !!status && status >= 500;
        this.update({ error: issue, uncertainCommand: uncertain ? command : null });
      }
      throw error;
    } finally { this.update({ busy: null }); }
  }
  async retryUncertain() {
    const command = this.state.uncertainCommand;
    if (!command) return;
    await this.execute(command, command);
    this.update({ notice: 'Original request checked. Review the saved state before continuing.' });
  }
  private pendingRefresh: Promise<void> | null = null;
  private pendingProjectRefresh: Promise<void> | null = null;
  refreshProjects(): Promise<void> {
    if (this.state.busy || this.state.phase === 'loading') return Promise.resolve();
    if (this.pendingProjectRefresh) return this.pendingProjectRefresh;
    const pending = this.readProjects().finally(() => { if (this.pendingProjectRefresh === pending) this.pendingProjectRefresh = null; });
    this.pendingProjectRefresh = pending;
    return pending;
  }
  private async readProjects() {
    const navigation = this.navigation;
    try {
      const projects = await this.api.listProjects();
      if (navigation !== this.navigation) return;
      this.update(this.state.uncertainCommand ? { projects } : { projects, error: null, phase: 'ready' });
    } catch (error) {
      if (navigation === this.navigation && !this.state.uncertainCommand) this.update({ error: this.errorOf(error), phase: 'error' });
    }
  }
  refresh(): Promise<void> {
    if (this.state.busy || this.state.phase === 'loading') return Promise.resolve();
    if (this.pendingRefresh) return this.pendingRefresh;
    const pending = this.readStatus().finally(() => { if (this.pendingRefresh === pending) this.pendingRefresh = null; });
    this.pendingRefresh = pending;
    return pending;
  }
  private async readStatus() {
    const projectId = this.state.workspace?.project?.id;
    const navigation = this.navigation;
    const readVersion = ++this.readVersion;
    try {
      const workspace = await this.api.getWorkspace(projectId);
      if (navigation === this.navigation && readVersion === this.readVersion) {
        this.applyWorkspace(workspace);
        if (!this.state.uncertainCommand) this.update({ error: null });
      }
    } catch (error) {
      if (navigation === this.navigation && readVersion === this.readVersion) this.update({ error: this.errorOf(error) });
    }
  }
  async saveShot(shotId: string, expectedRevision: number, patch: ShotPatch) {
    const shot = this.requireShot(shotId);
    const version = this.editVersions.get(shotId);
    const receipt = await this.execute({ type: 'shot.update', projectId: shot.projectId, shotId, expectedRevision, patch });
    if (receipt.revision === undefined) throw new Error('The accepted save has no revision. Refresh before editing again.');
    if (this.editVersions.get(shotId) === version) {
      const dirtyShotIds = new Set(this.state.dirtyShotIds); dirtyShotIds.delete(shotId);
      this.update({ dirtyShotIds, notice: 'Shot saved.' });
    }
    const merged = {...shot.controls,...patch.controls};
    const {seed,...controls} = merged;
    // A later GET may include another actor's edit. Never advance this draft's
    // accepted base to that later revision or replace its submitted snapshot.
    return {...shot,...patch,controls:{...controls,...(seed == null ? {} : {seed})},bindings:{...shot.bindings,...patch.bindings},revision:receipt.revision};
  }
  clearDirty(shotId: string) {
    const dirtyShotIds = new Set(this.state.dirtyShotIds); dirtyShotIds.delete(shotId);
    this.update({ dirtyShotIds });
  }
  private requireSaved(shotId: string) {
    if (this.state.dirtyShotIds.has(shotId)) throw new Error('Save or discard your shot changes before continuing.');
    return this.requireShot(shotId);
  }
  async uploadAsset(file: File) {
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Create a project before importing media.');
    if (this.state.busy || this.state.uncertainCommand) throw new Error('Resolve the current action before importing.');
    const navigation = this.navigation;
    const readVersion = ++this.readVersion;
    this.busyNavigation = null; // an upload, not a navigation restore, owns the label now
    this.update({ busy: 'asset.upload', error: null });
    try {
      const asset = await this.api.uploadAsset(file, projectId);
      const workspace = await this.api.getWorkspace(projectId);
      const owned = workspace.assets.find(item => item.id === asset.id && item.projectId === projectId);
      if (!owned) throw new Error('The import returned, but the owned asset is not visible yet. Refresh before importing again.');
      if (navigation === this.navigation && readVersion === this.readVersion) {
        this.applyWorkspace(workspace);
        this.update({ notice: 'Image imported. Choose a start or end frame to use it in this shot.' });
      }
      return owned;
    } catch (error) { this.update({ error: this.errorOf(error) }); throw error; }
    finally { this.update({ busy: null }); }
  }
  private currentReview(reviewId: string) {
    const review = this.state.workspace?.reviews.find(item => item.id === reviewId);
    if (!review) throw new Error('Prepare a new generation review.');
    const shot = this.requireSaved(review.shotId);
    if (review.shotRevision !== shot.revision) throw new Error('The shot changed. Prepare a new generation review.');
    if (review.blockers.length) throw new Error('Resolve the blockers shown in this review before continuing.');
    return review;
  }
  async prepare(shotId: string, expectedRevision: number) {
    const shot = this.requireSaved(shotId);
    const receipt = await this.execute({ type: 'generation.prepare', projectId: shot.projectId, shotId, expectedRevision });
    const reviewId = receipt.reviewId ?? receipt.resourceId;
    if (!reviewId || !this.state.workspace?.reviews.some(item => item.id === reviewId)) throw new Error('The prepared review is not available. Refresh the project.');
    this.update({ reviewId });
  }
  async approve(reviewId: string, limits: { maxAttempts: number; maxCostUsd: string }) {
    const review = this.currentReview(reviewId);
    if (!Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1 || !/^\d+(?:\.\d+)?$/.test(limits.maxCostUsd)) throw new Error('Choose explicit attempt and cost limits.');
    await this.execute({ type: 'generation.approve', projectId: review.projectId, reviewId, ...limits });
  }
  private submitted = new Set<string>();
  async submit(reviewId: string) {
    if (this.submitted.has(reviewId)) throw new Error('This review was already submitted. Check its activity.');
    const review = this.currentReview(reviewId);
    if (!review.approved) throw new Error('Approve this exact review before generating.');
    await this.execute({ type: 'generation.submit', projectId: review.projectId, reviewId });
    this.submitted.add(reviewId);
    this.update({ reviewId: null, notice: 'Generation requested. Activity shows the provider’s actual state.' });
  }
  private inspections = new Map<string, { inspectionId: string; projectId: string; shotId: string; shotRevision: number; selectionRevision: number }>();
  /** A receipt is only usable inside the editorial revision the server recorded it for. */
  private pruneInspections(workspace: Workspace | null) {
    for (const [takeId, inspection] of this.inspections) {
      const shot = workspace?.shots.find(item => item.id === inspection.shotId && item.projectId === inspection.projectId);
      const take = workspace?.takes.find(item => item.id === takeId && item.shotId === inspection.shotId && item.projectId === inspection.projectId);
      if (!shot || !take || shot.revision !== inspection.shotRevision || shot.selectionRevision !== inspection.selectionRevision) this.inspections.delete(takeId);
    }
  }
  private scopeOf(inspection: { projectId: string; shotId: string; shotRevision: number; selectionRevision: number } | undefined) {
    const shot = this.state.workspace?.shots.find(item => item.id === inspection?.shotId && item.projectId === inspection.projectId);
    return !!inspection && !!shot && shot.revision === inspection.shotRevision && shot.selectionRevision === inspection.selectionRevision;
  }
  async inspectTake(takeId: string) {
    const take = this.state.workspace?.takes.find(item => item.id === takeId);
    if (!take) throw new Error('This take is not available in the current project.');
    const shot = this.state.workspace?.shots.find(item => item.id === take.shotId && item.projectId === take.projectId);
    if (!shot) throw new Error('Open this shot before inspecting its takes.');
    // Bind the receipt to the scope the caller and the server both observe now.
    const navigation = this.navigation;
    const { revision: shotRevision, selectionRevision } = shot;
    const receipt = await this.execute({ type: 'take.inspect', projectId: take.projectId, takeId });
    const inspectionId = receipt.inspectionId ?? receipt.resourceId;
    if (!inspectionId) throw new Error('No inspection receipt was returned. Selection remains unavailable.');
    // A receipt that lands after navigation or a revision change describes a
    // scope this client no longer shows, so it must never be cached.
    if (navigation !== this.navigation) throw new Error('Inspect this take again: the workspace changed while the inspection ran.');
    if (!this.scopeOf({ projectId: take.projectId, shotId: take.shotId, shotRevision, selectionRevision }))
      throw new Error('Inspect this take again: the shot changed while the inspection ran.');
    this.inspections.set(takeId, { inspectionId, projectId: take.projectId, shotId: take.shotId, shotRevision, selectionRevision });
    return { inspectionId };
  }
  async selectTake(shotId: string, takeId: string, expectedRevision: number, expectedSelectionRevision: number, inspectionId?: string) {
    const shot = this.requireSaved(shotId);
    const take = this.state.workspace?.takes.find(item => item.id === takeId && item.shotId === shotId && item.projectId === shot.projectId);
    if (!take) throw new Error('Choose a take from this shot.');
    const inspected = this.inspections.get(takeId);
    if (!inspected) throw new Error('Inspect this take before selecting it.');
    // The receipt proves inspection of one take in one revision scope; a stale
    // one must not reach the server as if it covered this selection attempt.
    if (inspected.projectId !== shot.projectId || inspected.shotId !== shotId
      || inspected.shotRevision !== shot.revision || inspected.selectionRevision !== shot.selectionRevision
      || inspected.shotRevision !== expectedRevision || inspected.selectionRevision !== expectedSelectionRevision)
      throw new Error('This inspection is out of date. Inspect this take again before selecting it.');
    if (inspectionId && inspected.inspectionId !== inspectionId) throw new Error('The inspection receipt does not match. Inspect this take again before selecting it.');
    await this.execute({ type: 'take.select', projectId: shot.projectId, shotId, takeId, expectedRevision, expectedSelectionRevision, inspectionId: inspected.inspectionId });
    this.update({ notice: 'Take selected.' });
  }
  async exportShot(shotId: string, expectedRevision: number, expectedSelectionRevision: number) {
    const shot = this.requireSaved(shotId);
    if (!shot.selectedTakeId) throw new Error('Select a take before exporting.');
    await this.execute({ type: 'export.create', projectId: shot.projectId, shotId, expectedRevision, expectedSelectionRevision });
    this.update({ notice: 'Export requested. The download appears when the owned file is ready.' });
  }
  async start(projectId?: string) {
    const navigation = ++this.navigation;
    this.update({ phase: 'loading', error: null });
    try {
      const projects = await this.api.listProjects();
      if (navigation !== this.navigation) return;
      this.update({ projects });
      if (projectId) await this.openProject(projectId);
      else if (projects.length === 0) await this.openProject();
      else this.update({ phase: 'ready', workspace: null, activeShotId: null, reviewId: null });
    } catch (error) { if (navigation === this.navigation) this.update({ phase: 'error', error: this.errorOf(error) }); }
  }
  async createProject(name: string, brief: string) {
    if (!name.trim()) throw new Error('Give your project a name.');
    await this.execute({ type: 'project.create', name, brief });
    this.update({ projects: await this.api.listProjects(), notice: 'Project created.' });
  }
  async createShot(title: string, prompt: string) {
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Create a project first.');
    if (!title.trim()) throw new Error('Give your shot a name.');
    const receipt = await this.execute({ type: 'shot.create', projectId, title, prompt });
    if (!receipt.resourceId || !this.state.workspace?.shots.some(shot => shot.id === receipt.resourceId)) throw new Error('The shot was created but is not visible. Refresh this project.');
    this.update({ activeShotId: receipt.resourceId, reviewId: null, notice: 'Shot created.' });
  }
  selectShot(shotId: string) {
    if (this.state.busy || this.state.activeShotId && this.state.dirtyShotIds.has(this.state.activeShotId)) return false;
    if (!this.state.workspace?.shots.some(shot => shot.id === shotId)) return false;
    this.update({ activeShotId: shotId, reviewId: null, notice: null });
    return true;
  }
  dismissReview() { this.update({ reviewId: null }); }
  async resume(attemptId: string) {
    const attempt = this.state.workspace?.attempts.find(item => item.id === attemptId);
    if (!attempt) throw new Error('This attempt is not part of the current project.');
    await this.execute({ type: 'attempt.resume', projectId: attempt.projectId, attemptId });
  }
  // ---- Wave 2 authoring: frame reviews, storyboard proposals, continue-shot ----
  // Every method below uses the fixed authoring routes. None of them is a video
  // command: no generation.prepare, take.inspect or attempt.resume for a still image.
  private authoringEpoch = 0;
  private authoringLoad = 0;
  private frameReviews = new Map<string, string>();
  private requireAuthoring(): AuthoringPort {
    if (!this.authoring) throw new Error('Frame authoring is not available in this workspace.');
    return this.authoring;
  }
  private authoringScope(projectId: string): string {
    this.requireAuthoring();
    if (this.state.busy) throw new Error('Wait for the current action to finish.');
    if (this.state.uncertainCommand) throw new Error('Resolve the previous request before starting another action.');
    const open = this.state.workspace?.project;
    if (!open || open.id !== projectId) throw new Error('Open this project before using its authoring tools.');
    return open.id;
  }
  private requireCleanShot(projectId: string, shotId: string, expectedRevision?: number) {
    if (this.state.dirtyShotIds.has(shotId)) throw new Error('Save or discard your shot changes before using frame authoring.');
    const shot = this.state.workspace?.shots.find(item => item.id === shotId && item.projectId === projectId);
    if (!shot) throw new Error('Open this shot before authoring a frame.');
    if (expectedRevision !== undefined && shot.revision !== expectedRevision) throw new Error(`This request was prepared for revision ${expectedRevision}, but the shot is now revision ${shot.revision}. Prepare a new review.`);
    return shot;
  }
  private async runAuthoring<T>(label: string, action: () => Promise<T>): Promise<T> {
    const navigation = this.navigation;
    const epoch = ++this.authoringEpoch;
    this.busyNavigation = null; // an authoring action, not a navigation restore, owns the label now
    this.update({ busy: label, error: null });
    try {
      const value = await action();
      // A late result describes a workspace this client no longer shows.
      if (navigation !== this.navigation || epoch !== this.authoringEpoch) throw new Error('The workspace changed while this request ran. Check the current state before trying again.');
      return value;
    } catch (error) {
      this.update({ error: this.errorOf(error) });
      throw error;
    } finally {
      if (epoch === this.authoringEpoch) this.update({ busy: null });
    }
  }
  /** Authoritative read after a real mutation. A failed read never claims the write. */
  private async refreshAfterWrite(projectId: string): Promise<boolean> {
    const navigation = this.navigation;
    const readVersion = ++this.readVersion;
    try {
      const workspace = await this.api.getWorkspace(projectId);
      if (navigation !== this.navigation || readVersion !== this.readVersion) return false;
      if (workspace.project?.id !== projectId) return false;
      this.applyWorkspace(workspace);
      return true;
    } catch {
      this.update({ error: { code: 'READBACK_FAILED', message: 'The action was accepted, but its saved state could not be loaded. Refresh to check it; do not repeat it.' } });
      return false;
    }
  }
  async loadAuthoring(): Promise<void> {
    const api = this.authoring;
    if (!api) return;
    const navigation = this.navigation;
    const request = ++this.authoringLoad;
    if (this.state.authoring.phase !== 'ready') this.update({ authoring: { ...this.state.authoring, phase: 'loading', error: null } });
    try {
      const capabilities = await api.capabilities();
      if (navigation !== this.navigation || request !== this.authoringLoad) return;
      this.update({ authoring: { ...this.state.authoring, phase: 'ready', capabilities, error: null } });
    } catch (error) {
      if (navigation !== this.navigation || request !== this.authoringLoad) return;
      this.update({ authoring: { ...this.state.authoring, phase: 'error', capabilities: null, error: this.errorOf(error) } });
    }
  }
  async prepareFrameReview(draft: FrameAuthoringDraft): Promise<FrameReview> {
    const api = this.requireAuthoring();
    this.authoringScope(draft.projectId);
    this.requireCleanShot(draft.projectId, draft.shotId, draft.expectedRevision);
    return this.runAuthoring('frame.review', () => api.createFrameReview(draft));
  }
  async approveAndGenerate(review: FrameReview, limits: { maxAttempts: number; maxCostUsd: string }): Promise<FrameSubmission> {
    const api = this.requireAuthoring();
    this.authoringScope(review.projectId);
    this.requireCleanShot(review.projectId, review.shotId, review.expectedRevision);
    if (review.estimateUsd === null) throw new Error('No price estimate was returned. Unknown is not free, so nothing can be sent.');
    if (review.status !== 'ready' || review.blockers.length > 0) throw new Error('Resolve the blockers shown in this review before generating.');
    const maxCostUsd = limits.maxCostUsd.trim();
    if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(maxCostUsd)) throw new Error('Enter a spending limit in USD, for example 0.42.');
    if (Number(maxCostUsd) < review.estimateUsd) throw new Error('The spending limit is below the quoted estimate.');
    const result = await this.runAuthoring('frame.generate', () => api.generateFrame(review.reviewId, { projectId: review.projectId, expectedRevision: review.expectedRevision, maxCostUsd }));
    if (result.review.reviewId !== review.reviewId || result.review.projectId !== review.projectId) throw new Error('The returned review does not match this request. Check it before trying again.');
    if (result.submission.assetId) this.frameReviews.set(result.submission.assetId, review.reviewId);
    // A stored attempt/result is a real mutation: read the authoritative workspace.
    await this.refreshAfterWrite(review.projectId);
    return result.submission;
  }
  async checkFrameSubmission(reviewId: string): Promise<FrameSubmission> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Open this project before checking its frame reviews.');
    const result = await this.runAuthoring('frame.check', () => api.readFrameReview(reviewId, projectId));
    if (result.review.projectId !== projectId) throw new Error('The returned review belongs to another project.');
    if (result.submission.assetId) this.frameReviews.set(result.submission.assetId, reviewId);
    return result.submission;
  }
  async importFrameResult(assetId: string): Promise<FrameInspection> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Open this project before importing a result.');
    const reviewId = this.frameReviews.get(assetId);
    if (!reviewId) throw new Error('This image was not returned by a review in the open project, so it cannot be imported.');
    // Explicit operator step: imports the exact staged bytes. No provider call.
    const inspection = await this.runAuthoring('frame.import', () => api.importFrameResult(reviewId, projectId));
    this.frameReviews.set(inspection.assetId, reviewId);
    await this.refreshAfterWrite(projectId);
    return inspection;
  }
  async bindFrame(input: FrameBindInput): Promise<FrameBindingReceipt> {
    const api = this.requireAuthoring();
    this.authoringScope(input.projectId);
    this.requireCleanShot(input.projectId, input.shotId, input.expectedRevision);
    const reviewId = this.frameReviews.get(input.assetId);
    if (!reviewId) throw new Error('Import the returned image before binding it.');
    const receipt = await this.runAuthoring('frame.bind', () => api.bindFrame(reviewId, input));
    if (receipt.shotId !== input.shotId || receipt.assetId !== input.assetId || receipt.role !== input.role) throw new Error('The binding receipt does not match this request. Check the shot before trying again.');
    await this.refreshAfterWrite(input.projectId);
    return receipt;
  }
  private setProposal(proposal: ComposerProposal | null) {
    this.update({ authoring: { ...this.state.authoring, proposal, recovery: null } });
    const projectId = this.state.workspace?.project?.id;
    try { if (projectId) this.proposalBookmarks?.write(projectId, proposal?.id ?? null); }
    catch { this.update({ notice: 'Browser recovery storage is unavailable. Keep the proposal ID to reopen it later.' }); }
  }
  /** Restore only server identity and state. Never accept, resume, import or generate. */
  async restoreStoryboard(): Promise<void> {
    const projectId = this.state.workspace?.project?.id;
    if (!projectId || !this.authoring || this.state.busy) return;
    let proposalId: string | null | undefined;
    try { proposalId = this.proposalBookmarks?.read(projectId); }
    catch { this.update({ notice: 'Browser recovery storage is unavailable. Open a saved proposal by its ID.' }); return; }
    if (!proposalId) return;
    const navigation = this.navigation;
    this.beginNavigationBusy('storyboard.restore', navigation);
    this.update({ authoring: { ...this.state.authoring, proposal: null,
      recovery: { phase: 'loading', proposalId, message: 'Reading the saved storyboard from the server…' } } });
    try {
      const proposal = await this.authoring.readProposal(proposalId, projectId);
      if (navigation !== this.navigation) return;
      if (proposal.id !== proposalId) throw new Error('The server returned a different storyboard.');
      this.update({ authoring: { ...this.state.authoring, proposal,
        recovery: { phase: 'restored', proposalId, message: 'Saved storyboard restored from the server. No actions were replayed.' } } });
    } catch {
      if (navigation === this.navigation) this.update({ authoring: { ...this.state.authoring, proposal: null,
        recovery: { phase: 'error', proposalId, message: 'Could not read the saved storyboard. Its identity is retained; checking again will not create shots or generate media.' } } });
    } finally {
      this.releaseNavigationBusy(navigation);
    }
  }
  async proposeStoryboard(brief: string): Promise<void> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Open a project before proposing a storyboard.');
    this.authoringScope(projectId);
    // The actual configured planner blocker; no placeholder proposal is ever invented.
    const storyboard = this.state.authoring.capabilities?.storyboard;
    if (!storyboard) throw new Error('The server has not reported storyboard availability. Nothing can be proposed yet.');
    if (!storyboard.available) throw new Error(storyboard.blocker ?? 'No storyboard planner is configured.');
    this.setProposal(await this.runAuthoring('storyboard.propose', () => api.createProposal({ projectId, brief })));
  }
  async openProposal(proposalId: string): Promise<void> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Open a project before opening a proposal.');
    this.authoringScope(projectId);
    this.setProposal(await this.runAuthoring('storyboard.open', () => api.readProposal(proposalId.trim(), projectId)));
  }
  private requireProposal(expectedRevision: number) {
    const projectId = this.state.workspace?.project?.id;
    const proposal = this.state.authoring.proposal;
    if (!projectId || !proposal) throw new Error('Open a storyboard proposal before acting on it.');
    this.authoringScope(projectId);
    if (expectedRevision !== proposal.revision) throw new Error('This proposal changed elsewhere. Reopen it before continuing.');
    return { projectId, proposal };
  }
  async reviseProposal(items: ComposerItemInput[], expectedRevision: number): Promise<void> {
    const api = this.requireAuthoring();
    const { projectId, proposal } = this.requireProposal(expectedRevision);
    this.setProposal(await this.runAuthoring('storyboard.revise', () => api.reviseProposal(proposal.id, { projectId, expectedRevision, items })));
  }
  async acceptProposal(expectedRevision: number): Promise<void> {
    const api = this.requireAuthoring();
    const { projectId, proposal } = this.requireProposal(expectedRevision);
    // Explicit acceptance creates shot records only; it authorizes no generation.
    const next = await this.runAuthoring('storyboard.accept', () => api.acceptProposal(proposal.id, { projectId, expectedRevision }));
    this.setProposal(next);
    // New shots are a real mutation: read them back before anything acts on them.
    await this.refreshAfterWrite(projectId);
  }
  async cancelProposal(): Promise<void> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    const proposal = this.state.authoring.proposal;
    if (!projectId || !proposal) throw new Error('Open a storyboard proposal before cancelling it.');
    this.authoringScope(projectId);
    this.setProposal(await this.runAuthoring('storyboard.cancel', () => api.cancelProposal(proposal.id, { projectId })));
  }
  async resumeProposal(retryFailed = false): Promise<void> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    const proposal = this.state.authoring.proposal;
    if (!projectId || !proposal) throw new Error('Open a storyboard proposal before resuming it.');
    this.authoringScope(projectId);
    const next = await this.runAuthoring('storyboard.resume', () => api.resumeProposal(proposal.id, { projectId, retryFailed }));
    this.setProposal(next);
    await this.refreshAfterWrite(projectId);
  }
  async continueFromTake(request: ContinueShotRequest): Promise<ContinueShotOutcome> {
    const api = this.requireAuthoring();
    this.authoringScope(request.projectId);
    // Identity only, written before dispatch: a transport loss still leaves a handle the operator
    // can reopen. The server journal, not this hint, is the authoritative record.
    this.rememberContinuation(request.projectId, request.operationId);
    const outcome = await this.runAuthoring('continue.shot', () => api.continueShot(request));
    if (outcome.projectId !== request.projectId) throw new Error('The continuation belongs to another project.');
    if (outcome.status === 'completed') await this.refreshAfterWrite(request.projectId);
    await this.rereadContinuation(request.projectId, request.operationId);
    return outcome;
  }

  // ---- Continuation recovery: identity in storage, authority on the server ----
  private rememberContinuation(projectId: string, operationId: string | null) {
    try { this.continuationBookmarks?.write(projectId, operationId); }
    catch { this.update({ notice: 'Browser recovery storage is unavailable. Keep the operation ID to check it later.' }); }
  }
  private setContinuation(projectId: string, operationId: string, view: ContinueShotPublicView | null, phase: 'loading' | 'restored' | 'error', message: string | null) {
    this.update({ authoring: { ...this.state.authoring, continuation: { phase, operationId, view, message } } });
  }
  /**
   * Recover the authoritative state with ONE authorized read. Never extracts, creates, binds,
   * acquires a lease or advances the journal, and never falls back to the mutating route.
   */
  async restoreContinuation(): Promise<void> {
    const projectId = this.state.workspace?.project?.id;
    if (!projectId || !this.authoring) return;
    let operationId: string | null;
    try { operationId = this.continuationBookmarks?.read(projectId) ?? null; }
    catch {
      this.update({ notice: 'Browser recovery storage is unavailable. Keep the operation ID to check it later.',
        authoring: { ...this.state.authoring, continuation: null } });
      return;
    }
    if (!operationId) {
      if (this.state.authoring.continuation) this.update({ authoring: { ...this.state.authoring, continuation: null } });
      return;
    }
    if (this.state.busy) return;
    const navigation = this.navigation;
    this.beginNavigationBusy('continuation.restore', navigation);
    this.setContinuation(projectId, operationId, null, 'loading', null);
    try {
      const view = await this.authoring.readContinuation(operationId, projectId);
      if (navigation !== this.navigation) return;
      if (view.operationId !== operationId || view.projectId !== projectId) throw new Error('The server returned a different continuation.');
      this.setContinuation(projectId, operationId, view, 'restored', null);
    } catch (error) {
      if (navigation !== this.navigation) return;
      this.setContinuation(projectId, operationId, null, 'error',
        error instanceof Error && error.message ? error.message : 'Could not read the saved continuation.');
    } finally {
      this.releaseNavigationBusy(navigation);
    }
  }
  /**
   * Explicit resume of the stored operation. The request carries identity only; the server replays
   * the frozen intention, so this client cannot submit a changed title, prompt or take.
   */
  async resumeContinuation(operationId: string): Promise<ContinueShotOutcome> {
    const api = this.requireAuthoring();
    const projectId = this.state.workspace?.project?.id;
    if (!projectId) throw new Error('Open a project before resuming a continuation.');
    this.authoringScope(projectId);
    const view = this.state.authoring.continuation?.view;
    if (!view || view.operationId !== operationId || view.projectId !== projectId) throw new Error('Open the saved continuation before resuming it.');
    if (view.active) throw new Error('Another request is already continuing this operation.');
    if (!view.resumable) throw new Error('This continuation cannot be resumed. Check the project before starting a new operation.');
    const outcome = await this.runAuthoring('continuation.resume', () => api.resumeContinuation(operationId, projectId));
    if (outcome.projectId !== projectId) throw new Error('The resumed continuation belongs to another project.');
    if (outcome.status === 'completed') await this.refreshAfterWrite(projectId);
    await this.rereadContinuation(projectId, operationId);
    return outcome;
  }
  /** Best-effort authoritative re-read after a mutation. It never turns saved work into a failure. */
  private async rereadContinuation(projectId: string, operationId: string): Promise<void> {
    const navigation = this.navigation;
    try {
      const view = await this.requireAuthoring().readContinuation(operationId, projectId);
      if (navigation !== this.navigation || view.projectId !== projectId || view.operationId !== operationId) return;
      this.setContinuation(projectId, operationId, view, 'restored', null);
    } catch {
      if (navigation !== this.navigation) return;
      this.setContinuation(projectId, operationId, this.state.authoring.continuation?.view ?? null, 'error',
        'The server answered, but the saved continuation could not be reread. The result above is authoritative.');
    }
  }
  dismissProposal() { this.setProposal(null); }
  reportError(error: unknown) { this.update({ error: this.errorOf(error) }); }
  cancelPendingNavigation() {
    ++this.navigation;
    ++this.readVersion;
    if (this.state.busy === 'storyboard.restore') { this.busyNavigation = null; this.update({ busy: null, authoring: { ...this.state.authoring, recovery: null } }); }
    if (this.state.busy === 'continuation.restore') { this.busyNavigation = null; this.update({ busy: null, authoring: { ...this.state.authoring, continuation: null } }); }
    if (this.state.phase === 'loading') this.update({ phase: 'ready', error: null });
  }
  async openProject(projectId?: string) {
    const navigation = ++this.navigation;
    // Release a label owned by the superseded navigation. The read it belongs to can no longer
    // finish this epoch, and keeping the label would refuse every command on the new project and
    // suppress that project's own storyboard/continuation restore.
    if (this.busyNavigation !== null && this.busyNavigation !== navigation) {
      this.busyNavigation = null;
      this.update({ busy: null });
    }
    const previousProjectId = this.state.workspace?.project?.id;
    const previousReviewId = this.state.reviewId;
    // Keep the current readback visible until its replacement is authoritative.
    // This also preserves review and draft context if the new read fails.
    this.update({ phase: 'loading', error: null });
    try {
      const workspace = await this.api.getWorkspace(projectId);
      if (navigation !== this.navigation) return;
      this.pruneInspections(workspace);
      const retainedReview = previousProjectId === workspace.project?.id
        ? workspace.reviews.find(review => review.id === previousReviewId
          && review.projectId === workspace.project?.id
          && workspace.shots.some(shot => shot.id === review.shotId && shot.projectId === review.projectId && shot.revision === review.shotRevision))
        : undefined;
      this.update({ workspace, activeShotId: retainedReview?.shotId ?? workspace.shots[0]?.id ?? null, reviewId: retainedReview?.id ?? null, phase: 'ready',
        authoring: { ...this.state.authoring, proposal: previousProjectId === workspace.project?.id ? this.state.authoring.proposal : null, recovery: null,
          continuation: previousProjectId === workspace.project?.id ? this.state.authoring.continuation ?? null : null } });
      await this.restoreStoryboard();
      await this.restoreContinuation();
    } catch (error) {
      if (navigation === this.navigation) this.update({ phase: 'error', error: { code: 'LOAD_FAILED', message: error instanceof Error ? error.message : 'Could not open this project.' } });
    }
  }
}
