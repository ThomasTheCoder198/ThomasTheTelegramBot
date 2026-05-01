import { streamText, type CoreMessage, type Tool } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import { chatModel } from "./providers.js";
import type { SessionManager } from "./session.js";

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `
# Identity

You are a personal AI assistant running inside Telegram. You are helpful, accurate, and concise.
You speak any language — always reply in the language the user wrote in.

Today's date: ${today}

# Response Format

- Use plain text suitable for Telegram. No Markdown headings (#), no raw HTML tags.
- Bold (**text**) and italic (*text*) are fine.
- When citing a source, include the URL inline.
- Keep answers focused. Do not restate the question.

# Tools

You have access to the following tools. **Only call a tool when the user's message genuinely requires it.** Do not call tools for greetings, casual chat, or stable factual questions (history, definitions, how-to guides).

## github_trending
Fetch the current trending repositories directly from github.com/trending.

**MUST use when the user asks about:**
- Top/trending GitHub repositories today, this week, or this month
- Popular repos on GitHub right now

**Do NOT use web_search for GitHub trending — always use github_trending instead.**

## web_search
Search the web for up-to-date information.

**MUST use when the user asks about:**
- Current prices (gold, stocks, crypto, currency exchange rates)
- Today's news, events, weather, sports scores, schedules
- Any information that changes over time or that you are not 100% certain about

**Do NOT use web_search for GitHub trending — use github_trending instead.**

**CRITICAL RULE:** For any time-sensitive or real-world data question, you MUST call web_search FIRST and answer ONLY based on the returned results. NEVER fabricate, estimate, or guess prices, numbers, statistics, or current data. If the search returns no useful results, say so honestly — do not fill in with made-up numbers.

**QUERY RULE:** Do NOT include dates in the search query string. The tool handles temporal filtering automatically.

# Honesty Policy

- If you don't know something and no tool can help, say "I don't know" rather than guessing.
- If a tool call fails or returns no data, tell the user honestly. Never fill gaps with fabricated information.
- Accuracy is more important than sounding confident.
`.trim();
}

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
              `[agent] onDelta threw: ${err instanceof Error ? err.message : String(err)}`,
            );
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
