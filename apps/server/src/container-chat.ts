import { createChatService, createOpenRouterChatProvider } from './chat-service.ts';
import {createOllamaChatProvider} from './chat-ollama.ts';
import { createFileChatStore } from './chat-store.ts';
import { readSecretFile } from './container-configuration.ts';
import {getChatModel,isOllamaChatModel} from '@flume/domain';

export type ChatProviderStack = {
  provider: NonNullable<Parameters<typeof createChatService>[0]['provider']>;
  configuredModels: Array<'ollama/kimi-k3'|'ollama/gemma4:31b'|'google/gemini-2.5-flash-lite'|'google/gemini-2.5-flash'|'openai/gpt-4.1-mini'>;
  /** Explicit credential accessor: the closure-held credential for a registered model, never a log. */
  getCredential(modelId: string): Promise<string | null>;
};

/**
 * Build the registered chat transports alone. Chat storage is NOT required: the storyboard planner
 * reuses these exact transports and this exact credential accessor, so there is one provider routing
 * decision in the server and no second dispatch path. Secrets stay inside these closures.
 */
export async function createChatProviderStack(
  env: Record<string, string | undefined>,
  resolveStandaloneOpenRouterCredential?:(env:Record<string,string|undefined>)=>string|null,
): Promise<ChatProviderStack> {
  const ollamaCredential=env.FLUME_OLLAMA_API_KEY_FILE?await readSecretFile(env.FLUME_OLLAMA_API_KEY_FILE,'FLUME_OLLAMA_API_KEY_FILE'):null;
  const openRouterCredential=env.FLUME_CHAT_API_KEY_FILE?await readSecretFile(env.FLUME_CHAT_API_KEY_FILE,'FLUME_CHAT_API_KEY_FILE'):resolveStandaloneOpenRouterCredential?.(env)??null;
  const ollama=createOllamaChatProvider({getCredential:async()=>ollamaCredential}),openRouter=createOpenRouterChatProvider({getCredential:async()=>openRouterCredential});
  const provider:ChatProviderStack['provider']={
    stream(input,signal){return(isOllamaChatModel(input.modelId)?ollama:openRouter).stream(input,signal);},
    propose(input,signal){const selected=isOllamaChatModel(input.modelId)?ollama:openRouter;if(!selected.propose)throw new Error('Selected chat provider does not support proposals.');return selected.propose(input,signal);},
  };
  const configuredModels:ChatProviderStack['configuredModels']=[
    ...(ollamaCredential?['ollama/kimi-k3' as const,'ollama/gemma4:31b' as const]:[]),
    ...(openRouterCredential?['google/gemini-2.5-flash-lite' as const,'google/gemini-2.5-flash' as const,'openai/gpt-4.1-mini' as const]:[]),
  ];
  return {
    provider, configuredModels,
    async getCredential(modelId){
      const model=getChatModel(modelId);
      if(model?.provider==='ollama')return ollamaCredential;
      if(model?.provider==='openrouter')return openRouterCredential;
      return null;
    },
  };
}

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
  const stack = await createChatProviderStack(env, resolveStandaloneOpenRouterCredential);
  if (stack.configuredModels.length === 0) throw new Error('FLUME_OLLAMA_API_KEY_FILE or FLUME_CHAT_API_KEY_FILE is required when chat storage is enabled.');
  return createChatService({
    store: await createFileChatStore({ root }),
    provider: stack.provider,
    getWorkspace,
    configuredModels: stack.configuredModels,
    ...(command ? { command } : {}),
    ...(resolveVisual?{resolveVisual}:{}),
  });
}
