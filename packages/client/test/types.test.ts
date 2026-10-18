import { test } from 'node:test';
import type { AgentCommand, Command, Workspace } from '@flume/domain';
import { FlumeClient, type BrowserFlumeClient } from '../src/index.js';

// Compiled by the root typecheck; not executed against a live server.
function contractTypes(agent: FlumeClient, operator: BrowserFlumeClient, command: Command, input: AgentCommand): Promise<Workspace> {
  void agent.command(input);
  void operator.command(command);
  // @ts-expect-error Approval must not be accepted by the agent client at compile time.
  void agent.command({ type: 'generation.approve', commandId: 'x', projectId: 'p', reviewId: 'r', maxAttempts: 1, maxCostUsd: '1' });
  return agent.getWorkspace();
}
test('type surface is checked by tsc without making live API calls', () => { void contractTypes; });
