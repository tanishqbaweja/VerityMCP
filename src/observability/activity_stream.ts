/**
 * VerityMCP - First-Class Live Activity & Progress Event Stream
 * Provides structured live operational feed without private model chain-of-thought.
 */

export type ActivityEventType =
  | "plan"
  | "action_started"
  | "action_progress"
  | "action_completed"
  | "verification"
  | "fallback"
  | "retry"
  | "warning"
  | "failure"
  | "cleanup"
  | "info";

export interface ActivityEvent {
  event_id: string;
  seq: number;
  timestamp: string;
  type: ActivityEventType;
  title: string;
  purpose?: string;
  tool?: string;
  call_id?: string;
  target?: Record<string, unknown> | string;
  evidence?: Record<string, unknown> | string;
  reason?: string;
  next_action?: string;
  workspace_id?: string;
  browser_session_id?: string;
  process_session_id?: string;
  details?: Record<string, unknown>;
}

export interface ActivityReadOptions {
  cursor?: number;
  limit?: number;
  workspace_id?: string;
  browser_session_id?: string;
  process_session_id?: string;
  type?: ActivityEventType;
}

export interface ActivityReadResult {
  events: ActivityEvent[];
  cursor: number;
  next_cursor: number;
  has_more: boolean;
  total_retained: number;
}

export class ActivityStreamManager {
  private events: ActivityEvent[] = [];
  private seqCounter = 0;
  private maxEvents: number;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  public generateCallId(): string {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  public emit(eventData: Omit<ActivityEvent, "event_id" | "seq" | "timestamp">): ActivityEvent {
    this.seqCounter++;
    const event: ActivityEvent = {
      event_id: `evt_${Date.now()}_${this.seqCounter}`,
      seq: this.seqCounter,
      timestamp: new Date().toISOString(),
      ...eventData,
    };

    this.events.push(event);

    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    return event;
  }

  public read(options: ActivityReadOptions = {}): ActivityReadResult {
    const { cursor = 0, limit = 50, workspace_id, browser_session_id, process_session_id, type } = options;

    let filtered = this.events.filter((e) => e.seq > cursor);

    if (workspace_id) {
      filtered = filtered.filter((e) => e.workspace_id === workspace_id);
    }
    if (browser_session_id) {
      filtered = filtered.filter((e) => e.browser_session_id === browser_session_id);
    }
    if (process_session_id) {
      filtered = filtered.filter((e) => e.process_session_id === process_session_id);
    }
    if (type) {
      filtered = filtered.filter((e) => e.type === type);
    }

    const effectiveLimit = Math.max(1, Math.min(limit, 500));
    const sliced = filtered.slice(0, effectiveLimit);
    const has_more = filtered.length > effectiveLimit;

    const next_cursor = sliced.length > 0 ? sliced[sliced.length - 1].seq : cursor;

    return {
      events: sliced,
      cursor,
      next_cursor,
      has_more,
      total_retained: this.events.length,
    };
  }

  public list(limit = 50): ActivityEvent[] {
    const effectiveLimit = Math.max(1, Math.min(limit, 500));
    return this.events.slice(-effectiveLimit);
  }

  public clear(): { cleared_count: number } {
    const count = this.events.length;
    this.events = [];
    this.seqCounter = 0;
    return { cleared_count: count };
  }

  public size(): number {
    return this.events.length;
  }
}

export const activityStream = new ActivityStreamManager(1000);
