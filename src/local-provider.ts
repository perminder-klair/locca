import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { customProvider } from 'ai';

// This preload runs only in the isolated Eve process, before its workflow modules.
// Durable model IDs also need a local resolver for compaction and restart replay.
const baseURL = process.env.LOCCA_INFERENCE_URL;
if (!baseURL) throw new Error('Locca inference endpoint is required.');
const local = createOpenAICompatible({
  name: 'locca',
  baseURL,
  apiKey: process.env.LOCCA_INFERENCE_TOKEN,
});
const modelId = process.env.LOCCA_MODEL_ID;
if (!modelId) throw new Error('Locca model ID is required.');
globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
  languageModels: { [`locca/${modelId}`]: local.chatModel(modelId) },
});
