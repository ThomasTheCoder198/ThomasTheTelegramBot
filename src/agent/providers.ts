import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../config.js";

export const openrouter = createOpenRouter({
  apiKey: config.openrouterApiKey,
});

const modelChain = [config.openrouterModel, ...config.openrouterFallbackModels];

export const chatModel = openrouter.chat(
  config.openrouterModel,
  modelChain.length > 1 ? { extraBody: { models: modelChain } } : undefined,
);

if (modelChain.length > 1) {
  console.info(`[providers] OpenRouter model chain: ${modelChain.join(" → ")}`);
}
