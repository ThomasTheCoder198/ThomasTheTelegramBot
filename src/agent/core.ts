import { streamText, type CoreMessage, type Tool } from "ai";
import { buildSystemPrompt } from "../prompts.js";
import type { ToolRegistry } from "../tools/registry.js";
import { errorMessage } from "../utils.js";
import { chatModel } from "./providers.js";
import type { SessionManager } from "./session.js";

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
    const systemPrompt = options.systemPrompt ?? buildSystemPrompt();
    const maxSteps = options.maxSteps ?? MAX_STEPS;

    this.sessions.addUserMessage(chatId, userText);
    const history: CoreMessage[] = this.sessions
      .getOrCreate(chatId)
      .messages.slice();
    const tools: Record<string, Tool> = this.registry.getAISDKTools();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () =>
        controller.abort(
          new Error(
            `LLM request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
          ),
        ),
      REQUEST_TIMEOUT_MS,
    );

    const toolNames = Object.keys(tools);
    console.log(
      `[agent] → LLM request | model=${String(chatModel)} chatId=${chatId} historyMessages=${history.length} tools=[${toolNames.join(",")}] maxSteps=${maxSteps}`,
    );
    console.log(
      `[agent] payload messages:\n${JSON.stringify(history.map((m) => ({ role: m.role, contentLength: typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? m.content.length : 0 })), null, 2)}`,
    );

    const result = streamText({
      model: chatModel,
      system: systemPrompt,
      messages: history,
      tools,
      toolChoice: "auto",
      maxSteps,
      temperature: 0.3,
      abortSignal: controller.signal,
      onChunk: ({ chunk }) => {
        if (chunk.type === "tool-call") {
          console.log(
            `[agent] tool call: ${chunk.toolName}(${JSON.stringify(chunk.args)})`,
          );
        }
      },
    });

    let fullText = "";
    try {
      for await (const delta of result.textStream) {
        if (delta.length === 0) continue;
        fullText += delta;
        if (options.onDelta !== undefined) {
          try {
            await options.onDelta(delta);
          } catch (err) {
            console.warn(
              `[agent] onDelta threw: ${errorMessage(err)}`,
            );
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const finalText = (await result.text) || fullText;
    const usage = await result.usage.catch(() => null);
    if (usage !== null) {
      console.log(
        `[agent] ← LLM response | chatId=${chatId} promptTokens=${usage.promptTokens} completionTokens=${usage.completionTokens} totalTokens=${usage.totalTokens} textLength=${finalText.length}`,
      );
    }
    const responseMessages = await result.response.then((r) => r.messages);

    if (responseMessages.length > 0) {
      this.sessions.addAssistantResponse(chatId, responseMessages);
    } else if (finalText.length > 0) {
      this.sessions.addAssistantResponse(chatId, finalText);
    }

    return { text: finalText };
  }
}
