import { createChatService, createOpenRouterChatProvider } from './chat-service.ts';
import {createOllamaChatProvider} from './chat-ollama.ts';
import { createFileChatStore } from './chat-store.ts';
import { readSecretFile } from './container-configuration.ts';
import {isOllamaChatModel} from '@flume/domain';

/** Text chat is separately opt-in; it never enables media workers. */
export async function createContainerChat(
  env: Record<string, string | undefined>,
  getWorkspace: Parameters<typeof createChatService>[0]['getWorkspace'],
  command?: Parameters<typeof createChatService>[0]['command'],
  resolveVisual?:Parameters<typeof createChatService>[0]['resolveVisual'],
  resolveStandaloneOpenRouterCredential?:(env:Record<string,string|undefined>)=>string|null,
) {
  const root = env.FLUME_CHAT_STORE_ROOT;
  if (!root) return undefined;
  // Fail closed before creating storage if explicit configuration is incomplete.
  const ollamaCredential=env.FLUME_OLLAMA_API_KEY_FILE?await readSecretFile(env.FLUME_OLLAMA_API_KEY_FILE,'FLUME_OLLAMA_API_KEY_FILE'):null;
  const openRouterCredential=env.FLUME_CHAT_API_KEY_FILE?await readSecretFile(env.FLUME_CHAT_API_KEY_FILE,'FLUME_CHAT_API_KEY_FILE'):resolveStandaloneOpenRouterCredential?.(env)??null;
  if(!ollamaCredential&&!openRouterCredential)throw new Error('FLUME_OLLAMA_API_KEY_FILE or FLUME_CHAT_API_KEY_FILE is required when chat storage is enabled.');
  const ollama=createOllamaChatProvider({getCredential:async()=>ollamaCredential}),openRouter=createOpenRouterChatProvider({getCredential:async()=>openRouterCredential});
  const provider:Parameters<typeof createChatService>[0]['provider']={
    stream(input,signal){return(isOllamaChatModel(input.modelId)?ollama:openRouter).stream(input,signal);},
    propose(input,signal){const selected=isOllamaChatModel(input.modelId)?ollama:openRouter;if(!selected.propose)throw new Error('Selected chat provider does not support proposals.');return selected.propose(input,signal);},
  };
  return createChatService({
    store: await createFileChatStore({ root }),
    provider,
    getWorkspace,
    configuredModels:[...(ollamaCredential?['ollama/kimi-k3' as const,'ollama/gemma4:31b' as const]:[]),...(openRouterCredential?['google/gemini-2.5-flash-lite' as const,'google/gemini-2.5-flash' as const,'openai/gpt-4.1-mini' as const]:[])],
    ...(command ? { command } : {}),
    ...(resolveVisual?{resolveVisual}:{}),
  });
}
