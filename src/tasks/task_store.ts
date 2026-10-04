import { randomUUID } from "node:crypto";
import type { TaskItem, StandardToolResponse } from "../types/index.js";

export class TaskStore {
  private tasks = new Map<string, TaskItem>();

  public createTask(
    subject: string,
    description?: string
  ): StandardToolResponse<TaskItem> {
    const id = `task_${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const task: TaskItem = {
      id,
      subject,
      description,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(id, task);

    return {
      success: true,
      action: `task_create "${subject}"`,
      text: `Created task "${subject}" [ID: ${id}] (status: pending)`,
      verification: {
        performed: true,
        passed: true,
        method: "task_store_persistence",
        details: { taskId: id },
      },
      data: task,
    };
  }

  public updateTask(
    id: string,
    updates: {
      status?: "pending" | "in_progress" | "completed" | "failed";
      subject?: string;
      description?: string;
    }
  ): StandardToolResponse<TaskItem> {
    const task = this.tasks.get(id);
    if (!task) {
      return {
        success: false,
        action: `task_update "${id}"`,
        text: `Task with ID "${id}" not found.`,
        verification: {
          performed: true,
          passed: false,
          method: "task_store_lookup",
          error: "Task ID does not exist",
        },
      };
    }

    if (updates.status) task.status = updates.status;
    if (updates.subject) task.subject = updates.subject;
    if (updates.description) task.description = updates.description;
    task.updatedAt = Date.now();

    return {
      success: true,
      action: `task_update "${id}"`,
      text: `Updated task "${task.subject}" [ID: ${id}] to status "${task.status}".`,
      verification: {
        performed: true,
        passed: true,
        method: "task_store_persistence",
        details: { taskId: id, status: task.status },
      },
      data: task,
    };
  }

  public listTasks(): StandardToolResponse<TaskItem[]> {
    const allTasks = Array.from(this.tasks.values());
    const lines = allTasks.map(
      (t) => `[${t.status.toUpperCase().padEnd(11)}] ${t.id} : ${t.subject}`
    );

    const text =
      allTasks.length > 0
        ? `Tasks (${allTasks.length}):\n${lines.join("\n")}`
        : "No active tasks in store.";

    return {
      success: true,
      action: "task_list",
      text,
      verification: {
        performed: true,
        passed: true,
        method: "task_store_read",
        details: { taskCount: allTasks.length },
      },
      data: allTasks,
    };
  }
}

export const taskStore = new TaskStore();
