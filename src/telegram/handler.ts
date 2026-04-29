import type { AgentCore } from "../agent/core.js";
import type { SessionManager } from "../agent/session.js";
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramUpdate,
} from "./client.js";

const PLACEHOLDER_TEXT = "⏳ Thinking…";
const SESSION_RESET_TEXT = "🔄 New conversation started (previous context cleared due to inactivity).";
const TYPING_INTERVAL_MS = 4_000;
const EDIT_INTERVAL_MS = 3_500;
const EDIT_CHAR_THRESHOLD = 200;
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

// Telegram may append @BotName to commands in groups — stripped automatically.
const COMMAND_MAP: Record<string, string> = {
  "/giavang": "Giá vàng ngày hôm nay là bao nhiêu",
  "/github": "Top 10 repo trên github ngày hôm nay",
};

export interface HandlerDeps {
  telegram: TelegramClient;
  agent: AgentCore;
  sessions: SessionManager;
  allowedUserIds: Set<number>;
}

function clampForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) return text;
  return text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1) + "…";
}

function logError(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[handler] ${label} failed: ${message}`);
}

export async function handleUpdate(
  deps: HandlerDeps,
  update: TelegramUpdate,
): Promise<void> {
  const message = update.message ?? update.edited_message;
  if (message === undefined) return;

  const sender = message.from;
  if (sender === undefined) return;
  if (!deps.allowedUserIds.has(sender.id)) return;

  const chatId = message.chat.id;

  let text = typeof message.text === "string" ? message.text.trim() : "";
  if (text.length === 0) {
    await deps.telegram
      .sendMessage(chatId, "Sorry — I can only handle text messages right now.")
      .catch((err) => logError("non-text reply", err));
    return;
  }

  if (text.startsWith("/")) {
    const command = text.split(/\s+/)[0].replace(/@\S+$/, "").toLowerCase();
    const mapped = COMMAND_MAP[command];
    if (mapped === undefined) return;
    text = mapped;
  }

  if (deps.sessions.isExpired(chatId)) {
    await deps.telegram
      .sendMessage(chatId, SESSION_RESET_TEXT)
      .catch((err) => logError("session reset notice", err));
  }

  // Typing indicator — fire immediately, then repeat every 4s until response is sent.
  const typingTimer = setInterval(() => {
    void deps.telegram.sendChatAction(chatId, "typing").catch(() => {});
  }, TYPING_INTERVAL_MS);
  typingTimer.unref();
  void deps.telegram.sendChatAction(chatId, "typing").catch(() => {});

  // Send the placeholder message that will be progressively edited.
  let placeholderId: number | null = null;
  try {
    const placeholder = await deps.telegram.sendMessage(chatId, PLACEHOLDER_TEXT);
    placeholderId = placeholder.message_id;
  } catch (err) {
    clearInterval(typingTimer);
    logError("send placeholder", err);
    return;
  }

  let accumulated = "";
  let lastEditAt = Date.now();
  let lastEditedText = PLACEHOLDER_TEXT;
  let charsSinceEdit = 0;
  let editingSuspended = false;
  let editInFlight: Promise<unknown> = Promise.resolve();

  const maybeEdit = (force: boolean) => {
    if (placeholderId === null || editingSuspended) return;
    const elapsed = Date.now() - lastEditAt;
    const shouldEdit =
      force ||
      (charsSinceEdit > 0 &&
        (elapsed >= EDIT_INTERVAL_MS || charsSinceEdit >= EDIT_CHAR_THRESHOLD));
    if (!shouldEdit) return;

    const snapshot = accumulated.length === 0 ? PLACEHOLDER_TEXT : clampForTelegram(accumulated);
    if (snapshot === lastEditedText) return;

    lastEditAt = Date.now();
    lastEditedText = snapshot;
    charsSinceEdit = 0;

    const captured = placeholderId;
    editInFlight = editInFlight.then(() =>
      deps.telegram.editMessageText(chatId, captured, snapshot).catch((err: unknown) => {
        if (err instanceof TelegramApiError && err.errorCode === 429) {
          editingSuspended = true;
          console.warn(
            `[handler] Telegram rate limit hit (retry_after=${err.retryAfter ?? "?"}s); suspending intermediate edits.`,
          );
          return;
        }
        logError("edit message", err);
      }),
    );
  };

  let finalText = "";
  let agentError: unknown = null;
  try {
    const result = await deps.agent.processMessage(chatId, text, {
      onDelta: (delta) => {
        accumulated += delta;
        charsSinceEdit += delta.length;
        maybeEdit(false);
      },
    });
    finalText = result.text;
  } catch (err) {
    agentError = err;
  } finally {
    clearInterval(typingTimer);
  }

  await editInFlight.catch(() => {});

  if (agentError !== null) {
    const msg = agentError instanceof Error ? agentError.message : String(agentError);
    console.error(`[handler] agent error for chat ${chatId}:`, agentError);
    await sendFinal(deps, chatId, placeholderId, clampForTelegram(`Sorry — something went wrong:\n${msg}`));
    return;
  }

  const replyText =
    finalText.trim().length > 0
      ? clampForTelegram(finalText.trim())
      : "I do not have a response for that. Could you rephrase or try again?";

  await sendFinal(deps, chatId, placeholderId, replyText);
}

async function sendFinal(
  deps: HandlerDeps,
  chatId: number,
  placeholderId: number | null,
  text: string,
): Promise<void> {
  if (placeholderId !== null) {
    try {
      await deps.telegram.editMessageText(chatId, placeholderId, text);
      return;
    } catch (err) {
      if (err instanceof TelegramApiError && err.errorCode === 429) {
        // Rate-limited — fall through to sendMessage.
      } else if (
        err instanceof TelegramApiError &&
        err.message.includes("message is not modified")
      ) {
        return;
      } else {
        logError("final edit", err);
      }
    }
  }
  await deps.telegram.sendMessage(chatId, text).catch((err) => logError("final sendMessage", err));
}
