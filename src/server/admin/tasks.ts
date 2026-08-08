import type {
  AdminTask,
  AdminTaskSeverity,
  AdminTaskState
} from "@/server/api/types";

export type AdminTaskCandidate = Omit<AdminTask, "state">;

export type StoredAdminTaskState = AdminTaskState & { taskKey: string };

const severityRank: Record<AdminTaskSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

const defaultState = (): AdminTaskState => ({
  assigneeUserId: null,
  status: "open",
  dueAt: null,
  snoozedUntil: null,
  note: null,
  revision: 0
});

export function materializeAdminTasks(
  candidates: AdminTaskCandidate[],
  storedStates: StoredAdminTaskState[]
): AdminTask[] {
  const states = new Map(storedStates.map((state) => [state.taskKey, state]));

  return candidates
    .map((candidate) => {
      const stored = states.get(candidate.key);
      return {
        ...candidate,
        state: stored
          ? {
              assigneeUserId: stored.assigneeUserId,
              status: stored.status,
              dueAt: stored.dueAt,
              snoozedUntil: stored.snoozedUntil,
              note: stored.note,
              revision: stored.revision
            }
          : defaultState()
      };
    })
    .sort((left, right) => {
      const severity =
        severityRank[left.severity] - severityRank[right.severity];
      if (severity !== 0) return severity;

      const leftDue = left.state.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDue = right.state.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return right.occurredAt.getTime() - left.occurredAt.getTime();
    });
}
