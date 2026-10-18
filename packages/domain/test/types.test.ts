import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Command, ProjectCreateCommand, ShotCreateCommand, ShotUpdateCommand,
  GenerationPrepareCommand, GenerationApproveCommand, GenerationSubmitCommand,
  AttemptResumeCommand, TakeInspectCommand, TakeSelectCommand, ExportCreateCommand,
} from '../src/index.js';

type PublishedCommands = ProjectCreateCommand | ShotCreateCommand | ShotUpdateCommand
  | GenerationPrepareCommand | GenerationApproveCommand | GenerationSubmitCommand
  | AttemptResumeCommand | TakeInspectCommand | TakeSelectCommand | ExportCreateCommand;
const coversEntireUnion: [Command] extends [PublishedCommands] ? ([PublishedCommands] extends [Command] ? true : false) : false = true;

test('explicit command type exports cover the canonical discriminated union', () => {
  assert.equal(coversEntireUnion, true);
});
