/**
 * VerityMCP - First-Class Live Activity & Progress Event Stream
 * Provides structured live operational feed without private model chain-of-thought.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
  display_title?: string;
  purpose?: string;
  purpose_source?: "caller" | "tool_default";
  expected_outcome?: string;
  tool?: string;
  call_id?: string;
  target?: Record<string, unknown> | string;
  status?: "running" | "verified" | "completed" | "failed" | "warning" | "blocked";
  evidence?: Record<string, unknown> | string;
  reason?: string;
  next_action?: string;
  workspace_id?: string;
  browser_session_id?: string;
  process_session_id?: string;
  details?: Record<string, unknown>;
}

export interface ActivityCallContext {
  callId: string;
  toolName: string;
  displayTitle: string;
  purpose?: string;
  purposeSource: "caller" | "tool_default";
  expectedOutcome?: string;
  target?: Record<string, unknown> | string;
  workspaceId?: string;
  browserSessionId?: string;
  processSessionId?: string;
  args?: Record<string, unknown>;
}

export const activityContextStorage = new AsyncLocalStorage<ActivityCallContext>();

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
  current_action?: ActivityEvent | null;
}

export class ActivityStreamManager {
  private events: ActivityEvent[] = [];
  private seqCounter = 0;
  private maxEvents: number;
  private listeners: Array<(event: ActivityEvent) => void> = [];
  private currentAction: ActivityEvent | null = null;

  constructor(maxEvents = 1000) {
    this.maxEvents = maxEvents;
  }

  public generateCallId(): string {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  public subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public getCurrentAction(): ActivityEvent | null {
    return this.currentAction;
  }

  public emit(eventData: Omit<ActivityEvent, "event_id" | "seq" | "timestamp">): ActivityEvent {
    this.seqCounter++;
    const ctx = activityContextStorage.getStore();

    const callerPurpose = ctx?.purposeSource === "caller" ? ctx.purpose : undefined;
    const resolvedPurpose = callerPurpose || eventData.purpose || ctx?.purpose;
    const resolvedPurposeSource = callerPurpose
      ? "caller"
      : (eventData.purpose_source || ctx?.purposeSource || (resolvedPurpose ? "tool_default" : undefined));

    const callerExpectedOutcome = ctx?.expectedOutcome;
    const resolvedExpectedOutcome = eventData.expected_outcome || callerExpectedOutcome;

    const mergedData = {
      ...eventData,
      call_id: eventData.call_id || ctx?.callId,
      tool: eventData.tool || ctx?.toolName,
      display_title: eventData.display_title || eventData.title || ctx?.displayTitle,
      purpose: resolvedPurpose,
      purpose_source: resolvedPurposeSource,
      expected_outcome: resolvedExpectedOutcome,
      target: eventData.target || ctx?.target,
      workspace_id: eventData.workspace_id || ctx?.workspaceId,
      browser_session_id: eventData.browser_session_id || ctx?.browserSessionId,
      process_session_id: eventData.process_session_id || ctx?.processSessionId,
    };

    const event: ActivityEvent = {
      event_id: `evt_${Date.now()}_${this.seqCounter}`,
      seq: this.seqCounter,
      timestamp: new Date().toISOString(),
      ...mergedData,
    };

    if (event.type === "action_started") {
      this.currentAction = event;
    } else if (
      event.type === "action_completed" ||
      event.type === "failure"
    ) {
      if (!this.currentAction || this.currentAction.call_id === event.call_id) {
        this.currentAction = null;
      }
    } else if (
      event.type === "verification" &&
      this.currentAction &&
      (!event.call_id || this.currentAction.call_id === event.call_id)
    ) {
      this.currentAction = { ...this.currentAction, status: event.status || "verified" };
    }

    this.events.push(event);

    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
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
      current_action: this.currentAction,
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
    this.currentAction = null;
    return { cleared_count: count };
  }

  public size(): number {
    return this.events.length;
  }
}

export const activityStream = new ActivityStreamManager(1000);
