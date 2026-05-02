import type { CoreMessage } from "ai";

export interface Session {
  chatId: number;
  messages: CoreMessage[];
  lastActivity: number;
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private readonly ttlMs: number;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(ttlMinutes: number) {
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      throw new Error(
        `SessionManager: ttlMinutes must be > 0 (got ${ttlMinutes}).`,
      );
    }
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /** Start the periodic cleanup interval. Call once at application startup. */
  startCleanup(): void {
    if (this.cleanupTimer !== null) return;
    this.cleanupTimer = setInterval(
      () => this.cleanupExpired(),
      CLEANUP_INTERVAL_MS,
    );
    // Don't keep the event loop alive solely for the cleanup timer.
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  /** Stop the periodic cleanup interval (used during graceful shutdown). */
  stopCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Return an existing live session for the chat or create a new empty one.
   * Sessions whose lastActivity is older than the TTL are treated as expired
   * and replaced.
   */
  getOrCreate(chatId: number): Session {
    const now = Date.now();
    const existing = this.sessions.get(chatId);
    if (existing !== undefined && now - existing.lastActivity <= this.ttlMs) {
      return existing;
    }
    const fresh: Session = {
      chatId,
      messages: [],
      lastActivity: now,
    };
    this.sessions.set(chatId, fresh);
    return fresh;
  }

  /** Append a user-role message to the session and refresh lastActivity. */
  addUserMessage(chatId: number, text: string): void {
    const session = this.getOrCreate(chatId);
    session.messages.push({ role: "user", content: text });
    session.lastActivity = Date.now();
  }

  /**
   * Append assistant turn(s) — including any tool-call/tool-result pairs — to
   * the session history. Accepts either a plain assistant string (simple case)
   * or an array of CoreMessage objects produced by the AI SDK's `response.messages`.
   */
  addAssistantResponse(chatId: number, response: string | CoreMessage[]): void {
    const session = this.getOrCreate(chatId);
    if (typeof response === "string") {
      session.messages.push({ role: "assistant", content: response });
    } else {
      for (const msg of response) {
        session.messages.push(msg);
      }
    }
    session.lastActivity = Date.now();
  }

  /** Return true if the session for this chat is absent or has expired. */
  isExpired(chatId: number): boolean {
    const existing = this.sessions.get(chatId);
    if (existing === undefined) return true;
    return Date.now() - existing.lastActivity > this.ttlMs;
  }

  /** Drop a single session (e.g. for /reset commands). */
  clear(chatId: number): void {
    this.sessions.delete(chatId);
  }

  /** Number of live (non-expired) sessions currently held in memory. */
  size(): number {
    return this.sessions.size;
  }

  private cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [chatId, session] of this.sessions) {
      if (now - session.lastActivity > this.ttlMs) {
        this.sessions.delete(chatId);
        removed += 1;
      }
    }
    return removed;
  }
}
