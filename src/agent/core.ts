import { streamText, type CoreMessage, type Tool } from 'ai';
import { chatModel } from './providers.js';
import type { SessionManager } from './session.js';
import type { ToolRegistry } from '../tools/registry.js';

const SYSTEM_PROMPT = [
  'You are a helpful, concise AI assistant operating inside a Telegram chat.',
  'You can speak any language — always reply in the same language the user wrote in.',
  'Reply in plain text suitable for a Telegram message — no Markdown headings, no HTML.',
  'You have a tool called `web_search`. You MUST call it before answering ANY question that involves:',
  'current prices (gold, stock, crypto, currency, etc.), today\'s news or events, weather,',
  'sports scores, schedules, or any information that changes over time.',
  'Do NOT answer from memory for these topics — search first, then answer using the results.',
  'When you cite a source, include the URL inline.',
  'For stable factual questions (history, definitions, how-to), answer directly without searching.',
  'Keep answers focused and avoid restating the question.',
].join(' ');

const MAX_STEPS = 10;
const REQUEST_TIMEOUT_MS = 90_000;

export interface ProcessMessageOptions {
  systemPrompt?: string;
  maxSteps?: number;
  onDelta?: (delta: string) => void | Promise<void>;
}

export interface ProcessMessageResult {
  text: string;
}

export class AgentCore {
  constructor(
    private readonly sessions: SessionManager,
    private readonly registry: ToolRegistry,
  ) {}

  async processMessage(
    chatId: number,
    userText: string,
    options: ProcessMessageOptions = {},
  ): Promise<ProcessMessageResult> {
    const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    const maxSteps = options.maxSteps ?? MAX_STEPS;

    this.sessions.addUserMessage(chatId, userText);
    const history: CoreMessage[] = this.sessions.getOrCreate(chatId).messages.slice();
    const tools: Record<string, Tool> = this.registry.getAISDKTools();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
      REQUEST_TIMEOUT_MS,
    );

    const result = streamText({
      model: chatModel,
      system: systemPrompt,
      messages: history,
      tools,
      toolChoice: 'auto',
      maxSteps,
      abortSignal: controller.signal,
      onChunk: ({ chunk }) => {
        if (chunk.type === 'tool-call') {
          console.log(`[agent] tool call: ${chunk.toolName}(${JSON.stringify(chunk.args)})`);
        }
      },
    });

    let fullText = '';
    try {
      for await (const delta of result.textStream) {
        if (delta.length === 0) continue;
        fullText += delta;
        if (options.onDelta !== undefined) {
          try {
            await options.onDelta(delta);
          } catch (err) {
            console.warn(`[agent] onDelta threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const finalText = (await result.text) || fullText;
    const responseMessages = await result.response.then((r) => r.messages);

    if (responseMessages.length > 0) {
      this.sessions.addAssistantResponse(chatId, responseMessages);
    } else if (finalText.length > 0) {
      this.sessions.addAssistantResponse(chatId, finalText);
    }

    return { text: finalText };
  }
}
