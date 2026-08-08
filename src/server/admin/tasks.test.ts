import { describe, expect, it } from "vitest";

import { materializeAdminTasks } from "./tasks";

describe("admin task materialization", () => {
  it("sorts by risk first and deadline second while preserving source truth", () => {
    const tasks = materializeAdminTasks(
      [
        {
          key: "feedback:f-1",
          sourceType: "feedback",
          sourceId: "f-1",
          sourceStatus: "open",
          title: "负向反馈",
          summary: "用户认为答案无帮助",
          href: "/admin/conversations?feedback=f-1",
          severity: "medium",
          occurredAt: new Date("2026-08-08T09:00:00.000Z")
        },
        {
          key: "auth:role-conflict-u-1",
          sourceType: "auth",
          sourceId: "u-1",
          sourceStatus: "conflict",
          title: "管理员角色冲突",
          summary: "迁移前必须处理",
          href: "/admin/admins",
          severity: "critical",
          occurredAt: new Date("2026-08-08T10:00:00.000Z")
        },
        {
          key: "knowledge:k-1",
          sourceType: "knowledge",
          sourceId: "k-1",
          sourceStatus: "review",
          title: "知识待审",
          summary: "需要人工审核",
          href: "/admin/knowledge?k=k-1",
          severity: "high",
          occurredAt: new Date("2026-08-08T08:00:00.000Z")
        }
      ],
      [
        {
          taskKey: "feedback:f-1",
          assigneeUserId: "admin-1",
          status: "in_progress",
          dueAt: new Date("2026-08-08T11:00:00.000Z"),
          snoozedUntil: null,
          note: "正在复核",
          revision: 2
        }
      ]
    );

    expect(tasks.map((task) => task.key)).toEqual([
      "auth:role-conflict-u-1",
      "knowledge:k-1",
      "feedback:f-1"
    ]);
    expect(tasks[0]).toMatchObject({
      severity: "critical",
      sourceStatus: "conflict",
      state: { status: "open", revision: 0 }
    });
    expect(tasks[2]?.state).toMatchObject({
      assigneeUserId: "admin-1",
      status: "in_progress",
      note: "正在复核",
      revision: 2
    });
  });
});
