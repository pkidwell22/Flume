import type { Command, CommandIntent, FlumePort, Receipt, ShotPatch, Workspace, WorkspaceError, WorkspaceState } from './types.ts';

export class WorkspaceController {
  private api: FlumePort;
  private state: WorkspaceState = { phase: 'idle', projects: [], workspace: null, activeShotId: null, busy: null, error: null, notice: null, reviewId: null, uncertainCommand: null, dirtyShotIds: new Set() };
  constructor(api: FlumePort) { this.api = api; }
  getSnapshot = () => this.state;
  private navigation = 0;
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
  reportError(error: unknown) { this.update({ error: this.errorOf(error) }); }
  cancelPendingNavigation() {
    ++this.navigation;
    ++this.readVersion;
    if (this.state.phase === 'loading') this.update({ phase: 'ready', error: null });
  }
  async openProject(projectId?: string) {
    const navigation = ++this.navigation;
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
      this.update({ workspace, activeShotId: retainedReview?.shotId ?? workspace.shots[0]?.id ?? null, reviewId: retainedReview?.id ?? null, phase: 'ready' });
    } catch (error) {
      if (navigation === this.navigation) this.update({ phase: 'error', error: { code: 'LOAD_FAILED', message: error instanceof Error ? error.message : 'Could not open this project.' } });
    }
  }
}
