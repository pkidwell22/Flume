/**
 * Shared authoring composition seam.
 *
 * Both server entry points build the authoring surface through this one function:
 *  - `main.ts` for the local launcher (`npm run dev`), and
 *  - `container-main.ts` for the Docker image.
 *
 * It exists because the container entry point used to compose no authoring runtime at all, so an
 * image built from this source served the authoring UI with no authoring endpoints behind it. One
 * seam means the two entry points cannot drift apart again.
 *
 * Nothing here reads `process.env`, a file or a provider URL: every port, path and credential is
 * injected by the entry point, and the entry point owns the difference between local (process
 * environment) and container (FILE-only) credential conventions.
 *
 * Honest defaults, never invented capability:
 *  - an absent image configuration stays `blocked`: no models, no estimates, no submit path;
 *  - an absent planner yields no storyboard service at all rather than an in-memory stand-in;
 *  - a missing durable staging root is a startup error, never a temporary-directory fallback.
 *
 * Durable state comes from the durable worker's journals (migrations 010/011), so composition
 * performs no SQL: constructors only build closures, and the first query happens when an operation
 * actually runs.
 */
import type { Pool } from 'pg';
import {
  createAuthoringRuntime, createConfiguredContinuation, createConfiguredFrameAuthoring,
  createConfiguredStoryboardRuntime, createFrameMediaPort, createSqlAuthoringJournals,
  type AuthoringCommandPorts, type AuthoringRuntime, type ImageAuthoringConfiguration,
  type StoryboardChatPort,
} from './authoring-runtime.ts';
import type { MediaPort } from './ports.ts';
import type { StoryboardPlannerConfiguration } from './storyboard-planner.ts';

/** Kept verbatim from the local launcher: a missing staging root is a startup error, not a fallback. */
export const STAGING_ROOT_REQUIRED_MESSAGE = 'FLUME_FRAME_STAGING_ROOT or FLUME_DATA_DIR is required for durable frame result staging.';

/** Storyboard planning is opt-in: the chat transports are only built when a planner is configured. */
export interface AuthoringPlannerInput {
  configuration: StoryboardPlannerConfiguration;
  /** Lazy, so a blocked planner never opens a credential file or builds a provider transport. */
  chat: () => Promise<StoryboardChatPort>;
}

export interface AuthoringCompositionInput {
  /** The real PostgreSQL pool: the durable review store, the journals and the owned-media adapter use it. */
  sql: Pool;
  /** The owned-media port owned by the API process; authoring never opens a second media store. */
  media: MediaPort;
  /** The project-owned command service; continuation replays real command shapes through it. */
  commands: AuthoringCommandPorts;
  /** Absolute server-owned staging directory, or null when the entry point has none. */
  stagingRoot: string | null;
  image: ImageAuthoringConfiguration;
  planner: AuthoringPlannerInput | null;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
  ids?: { reviewId?: () => string; assetId?: () => string };
}

/**
 * Compose the authoring runtime from injected ports. No I/O: the returned facade is safe to build
 * before `buildServer()` and before the API listens.
 */
export async function composeAuthoringRuntime(input: AuthoringCompositionInput): Promise<AuthoringRuntime> {
  const stagingRoot = input.stagingRoot;
  if (!stagingRoot) throw new Error(STAGING_ROOT_REQUIRED_MESSAGE);
  const frames = createConfiguredFrameAuthoring({
    sql: input.sql,
    media: createFrameMediaPort({ pool: input.sql, media: input.media }),
    stagingRoot,
    configuration: input.image,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.ids ? { ids: input.ids } : {}),
  });
  const journals = createSqlAuthoringJournals(input.sql);
  // Continuation owns no provider and no queue port: it extracts an owned frame and replays real
  // shot.create/shot.update commands, so it stays honest even while media workers are disabled.
  const continuation = createConfiguredContinuation({ journal: journals.continueShotJournal, commands: input.commands });
  const storyboard = input.planner
    ? await createConfiguredStoryboardRuntime({
        store: journals.storyboardStore,
        chat: await input.planner.chat(),
        configuration: input.planner.configuration,
        commands: input.commands,
      })
    : null;
  return createAuthoringRuntime({
    service: frames.service,
    continueShot: continuation,
    ...(storyboard ? { storyboard: storyboard.storyboard, storyboardBlocker: storyboard.storyboardBlocker } : {}),
  });
}
