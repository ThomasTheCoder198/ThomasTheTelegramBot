import { lexer, type Token, type Tokens } from "marked";

import type { AgentCore } from "../agent/core.js";
import type { SessionManager } from "../agent/session.js";
import {
  TelegramApiError,
  type TelegramClient,
  type TelegramUpdate,
} from "./client.js";

const PLACEHOLDER_TEXT = "⏳ Thinking…";
const SESSION_RESET_TEXT =
  "🔄 New conversation started (previous context cleared due to inactivity).";
const TYPING_INTERVAL_MS = 4_000;
const EDIT_INTERVAL_MS = 3_500;
const EDIT_CHAR_THRESHOLD = 200;
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export const COMMAND_MAP: Record<string, string> = {
  "/giavang":
    "Giá vàng ngày hôm nay là bao nhiêu, hãy tìm các bài báo được update vào hôm nay, không cần thiết phải vào trang chủ của tiệm vàng.",
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderTokens(tokens: Token[]): string {
  return tokens.map(renderToken).join("");
}

function renderToken(token: Token): string {
  switch (token.type) {
    // ── inline ──────────────────────────────────────────────────────────────
    case "text":
      return token.tokens ? renderTokens(token.tokens) : escapeHtml(token.text);
    case "escape":
      return escapeHtml(token.text);
    case "strong":
      return `<b>${renderTokens(token.tokens ?? [])}</b>`;
    case "em":
      return `<i>${renderTokens(token.tokens ?? [])}</i>`;
    case "del":
      return `<s>${renderTokens(token.tokens ?? [])}</s>`;
    case "codespan":
      return `<code>${escapeHtml(token.text)}</code>`;
    case "link":
      return `<a href="${escapeHtml(token.href)}">${renderTokens(token.tokens ?? [])}</a>`;
    case "image":
      return escapeHtml(token.text); // show alt text only
    case "br":
      return "\n";
    case "tag":
      return /^<br\s*\/?>$/i.test(token.text.trim()) ? "\n" : escapeHtml(token.text);

    // ── block ────────────────────────────────────────────────────────────────
    case "heading":
      return `<b>${renderTokens(token.tokens ?? [])}</b>\n\n`;
    case "paragraph":
      return `${renderTokens(token.tokens ?? [])}\n`;
    case "code":
      return `<pre><code>${escapeHtml(token.text)}</code></pre>\n\n`;
    case "blockquote": {
      const inner = renderTokens(token.tokens ?? []).trim();
      return (
        inner
          .split("\n")
          .map((l) => (l ? `❝ ${l}` : ""))
          .join("\n") + "\n\n"
      );
    }
    case "list":
      return renderList(token as Tokens.List) + "\n";
    case "table":
      return renderTable(token as Tokens.Table) + "\n";
    case "hr":
      return "───────────\n\n";
    case "html":
      return /^<br\s*\/?>$/i.test(token.text.trim()) ? "\n" : escapeHtml(token.text);
    case "space":
      return "";

    default:
      return "raw" in token ? escapeHtml((token as { raw: string }).raw) : "";
  }
}

function renderList(token: Tokens.List, depth = 0): string {
  const indent = "  ".repeat(depth);
  return token.items
    .map((item, i) => {
      const prefix = token.ordered
        ? `${(typeof token.start === "number" ? token.start : 1) + i}.`
        : item.task
          ? item.checked
            ? "☑"
            : "☐"
          : "•";

      const content = item.tokens
        .map((t) =>
          t.type === "list"
            ? "\n" + renderList(t as Tokens.List, depth + 1)
            : renderToken(t),
        )
        .join("")
        .trim();

      return `${indent}${prefix} ${content}`;
    })
    .join("\n");
}

function renderTable(token: Tokens.Table): string {
  const headers = token.header.map((cell) => renderTokens(cell.tokens));
  const rows = token.rows.map((row) =>
    row.map((cell) => renderTokens(cell.tokens)),
  );

  return rows
    .map((cells) => {
      const parts: string[] = [];
      for (let i = 0; i < headers.length; i++) {
        const val = (cells[i] ?? "").trim();
        if (!val) continue;
        parts.push(i === 0 ? `<b>${val}</b>` : `${headers[i]}: ${val}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

export function markdownToTelegramHtml(text: string): string {
  const cleaned = text.replace(/【\d+†[^】]*】/g, "");
  return renderTokens(lexer(cleaned)).trim();
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
    const placeholder = await deps.telegram.sendMessage(
      chatId,
      PLACEHOLDER_TEXT,
    );
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

    const snapshot =
      accumulated.length === 0
        ? PLACEHOLDER_TEXT
        : clampForTelegram(accumulated);
    if (snapshot === lastEditedText) return;

    lastEditAt = Date.now();
    lastEditedText = snapshot;
    charsSinceEdit = 0;

    const captured = placeholderId;
    editInFlight = editInFlight.then(() =>
      deps.telegram
        .editMessageText(chatId, captured, markdownToTelegramHtml(snapshot), {
          parse_mode: "HTML",
        })
        .catch((err: unknown) => {
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
    const msg =
      agentError instanceof Error ? agentError.message : String(agentError);
    console.error(`[handler] agent error for chat ${chatId}:`, agentError);
    await sendFinal(
      deps,
      chatId,
      placeholderId,
      clampForTelegram(`Sorry — something went wrong:\n${msg}`),
    );
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
  const html = markdownToTelegramHtml(text);
  const htmlOpts = { parse_mode: "HTML" as const };
  if (placeholderId !== null) {
    try {
      await deps.telegram.editMessageText(
        chatId,
        placeholderId,
        html,
        htmlOpts,
      );
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
  await deps.telegram
    .sendMessage(chatId, html, htmlOpts)
    .catch((err) => logError("final sendMessage", err));
}
