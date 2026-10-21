import { createChatService, createOpenRouterChatProvider } from './chat-service.ts';
import { createFileChatStore } from './chat-store.ts';
import { readSecretFile } from './container-configuration.ts';

/** Text chat is separately opt-in; it never enables media workers. */
export async function createContainerChat(
  env: Record<string, string | undefined>,
  getWorkspace: Parameters<typeof createChatService>[0]['getWorkspace'],
  command?: Parameters<typeof createChatService>[0]['command'],
) {
  const root = env.FLUME_CHAT_STORE_ROOT;
  if (!root) return undefined;
  // Fail closed before creating storage if explicit configuration is incomplete.
  const credential = await readSecretFile(env.FLUME_CHAT_API_KEY_FILE, 'FLUME_CHAT_API_KEY_FILE');
  return createChatService({
    store: await createFileChatStore({ root }),
    provider: createOpenRouterChatProvider({ getCredential: async () => credential }),
    getWorkspace,
    ...(command ? { command } : {}),
  });
}
