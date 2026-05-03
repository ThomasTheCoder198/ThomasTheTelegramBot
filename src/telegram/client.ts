import { errorMessage } from "../utils.js";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  // Catch-all for the rest of the optional fields we do not use directly.
  [key: string]: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  [key: string]: unknown;
}

export type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note";

export interface SendMessageOptions {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  reply_markup?: unknown;
}

export interface EditMessageTextOptions {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_web_page_preview?: boolean;
  reply_markup?: unknown;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TelegramApiError extends Error {
  public readonly errorCode: number | undefined;
  public readonly retryAfter: number | undefined;
  public readonly method: string;

  constructor(
    method: string,
    description: string,
    errorCode?: number,
    retryAfter?: number,
  ) {
    super(
      `Telegram API ${method} failed${errorCode !== undefined ? ` (${errorCode})` : ""}: ${description}`,
    );
    this.name = "TelegramApiError";
    this.method = method;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}



export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string) {
    if (!token) {
      throw new Error("TelegramClient requires a non-empty bot token.");
    }
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Generic helper that POSTs JSON to a Telegram method and returns the parsed result.
   * Throws TelegramApiError on non-ok responses.
   */
  async call<T>(
    method: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/${method}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const message = errorMessage(err);
      throw new TelegramApiError(method, `network error: ${message}`);
    }

    let data: TelegramApiResponse<T>;
    try {
      data = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(
        method,
        `invalid JSON response (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!data.ok) {
      throw new TelegramApiError(
        method,
        data.description ?? `HTTP ${response.status}`,
        data.error_code ?? response.status,
        data.parameters?.retry_after,
      );
    }

    if (data.result === undefined) {
      // Telegram always provides `result` for successful calls; treat absence as a protocol error.
      throw new TelegramApiError(
        method,
        'response missing "result" field',
        response.status,
      );
    }

    return data.result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...options,
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options: EditMessageTextOptions = {},
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...options,
    });
  }

  async sendChatAction(chatId: number, action: ChatAction): Promise<true> {
    return this.call<true>("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  /**
   * Long-poll for updates.
   *
   * @param offset  - last processed update_id + 1 (acknowledges previous updates).
   * @param timeout - long-poll timeout in seconds (Telegram caps at 50, default 25).
   * @param allowedUpdates - optional whitelist of update types.
   */
  async getUpdates(
    offset?: number,
    timeout: number = 25,
    allowedUpdates?: string[],
  ): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = { timeout };
    if (offset !== undefined) payload.offset = offset;
    if (allowedUpdates !== undefined) payload.allowed_updates = allowedUpdates;
    return this.call<TelegramUpdate[]>("getUpdates", payload);
  }
}
