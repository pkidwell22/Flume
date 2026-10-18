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
    let accepted = false;
    try {
      const receipt = await this.api.command(command);
      if (receipt.commandId !== command.commandId || 'projectId' in command && receipt.projectId !== command.projectId) throw new TypeError('The returned receipt does not match this request. Check the original request before continuing.');
      accepted = true;
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
  private inspections = new Map<string, string>();
  async inspectTake(takeId: string) {
    const take = this.state.workspace?.takes.find(item => item.id === takeId);
    if (!take) throw new Error('This take is not available in the current project.');
    const receipt = await this.execute({ type: 'take.inspect', projectId: take.projectId, takeId });
    const inspectionId = receipt.inspectionId ?? receipt.resourceId;
    if (!inspectionId) throw new Error('No inspection receipt was returned. Selection remains unavailable.');
    this.inspections.set(takeId, inspectionId);
    return { inspectionId };
  }
  async selectTake(shotId: string, takeId: string, expectedRevision: number, expectedSelectionRevision: number, inspectionId?: string) {
    const shot = this.requireSaved(shotId);
    const inspected = this.inspections.get(takeId);
    if (!inspected || inspectionId && inspected !== inspectionId) throw new Error('Inspect this take before selecting it.');
    if (!this.state.workspace?.takes.some(take => take.id === takeId && take.shotId === shotId)) throw new Error('Choose a take from this shot.');
    await this.execute({ type: 'take.select', projectId: shot.projectId, shotId, takeId, expectedRevision, expectedSelectionRevision, inspectionId: inspected });
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
      await this.openProject(projectId ?? projects[0]?.id);
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
  async openProject(projectId?: string) {
    const navigation = ++this.navigation;
    this.update({ phase: 'loading', workspace: null, error: null, activeShotId: null, reviewId: null });
    try {
      const workspace = await this.api.getWorkspace(projectId);
      if (navigation !== this.navigation) return;
      this.update({ workspace, activeShotId: workspace.shots[0]?.id ?? null, phase: 'ready' });
    } catch (error) {
      if (navigation === this.navigation) this.update({ phase: 'error', error: { code: 'LOAD_FAILED', message: error instanceof Error ? error.message : 'Could not open this project.' } });
    }
  }
}
