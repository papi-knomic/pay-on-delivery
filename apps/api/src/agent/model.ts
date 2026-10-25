import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export const AI_PROVIDERS = ['google', 'anthropic', 'openai'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

/** Any vision-capable model; picked by env so judges can bring their own key. */
export function createLanguageModel(cfg: AiConfig): LanguageModel {
  switch (cfg.provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.model);
    case 'anthropic':
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.model);
    case 'openai':
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.model);
  }
}
