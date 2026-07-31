export type ClosableTransport = {
  close(): Promise<void>;
};

export type SessionReservation<T extends ClosableTransport> = {
  commit(sessionId: string, transport: T): void;
  release(): void;
};

type SessionEntry<T> = {
  transport: T;
  lastAccessedAt: number;
};

export class TransportSessionStore<T extends ClosableTransport> {
  private readonly sessions = new Map<string, SessionEntry<T>>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private reservations = 0;

  constructor(options: { maxSessions: number; idleTtlMs: number; now?: () => number }) {
    this.maxSessions = options.maxSessions;
    this.idleTtlMs = options.idleTtlMs;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  async reserve(): Promise<SessionReservation<T> | undefined> {
    await this.sweepExpired();
    if (this.sessions.size + this.reservations >= this.maxSessions) {
      return undefined;
    }
    this.reservations += 1;
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      this.reservations -= 1;
    };
    return {
      commit: (sessionId, transport) => {
        if (!active) {
          throw new Error("Session reservation is no longer active.");
        }
        release();
        this.sessions.set(sessionId, { transport, lastAccessedAt: this.now() });
      },
      release
    };
  }

  get(sessionId: string): T | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.lastAccessedAt = this.now();
    return entry.transport;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  async sweepExpired(): Promise<{ expired: number; close_failures: number }> {
    const deadline = this.now() - this.idleTtlMs;
    const expired = [...this.sessions.entries()].filter(([, entry]) => entry.lastAccessedAt <= deadline);
    for (const [sessionId] of expired) {
      this.sessions.delete(sessionId);
    }
    const closeFailures = await closeTransports(expired.map(([, entry]) => entry.transport));
    return { expired: expired.length, close_failures: closeFailures };
  }

  async close(sessionId: string): Promise<boolean> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.sessions.delete(sessionId);
    await entry.transport.close();
    return true;
  }

  async closeAll(): Promise<{ closed: number; close_failures: number }> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    this.reservations = 0;
    const closeFailures = await closeTransports(entries.map((entry) => entry.transport));
    return { closed: entries.length, close_failures: closeFailures };
  }
}

async function closeTransports<T extends ClosableTransport>(transports: T[]): Promise<number> {
  const results = await Promise.allSettled(transports.map((transport) => transport.close()));
  return results.filter((result) => result.status === "rejected").length;
}
