import { ApiError } from "./errors";
import type { AdminRole } from "./types";

type OwnerRevocationInput = {
  role: AdminRole;
  ownerCount: number;
  targetUserId: string;
  actorUserId: string;
};

export function assertCurrentOwnerRole(
  roleAssignment: { role: AdminRole } | undefined
): void {
  if (roleAssignment?.role !== "owner") {
    throw new ApiError(
      403,
      "ADMIN_AUTHORIZATION_REVOKED",
      "当前 owner 权限已失效，请重新登录后重试。"
    );
  }
}

export function assertOwnerRoleRevocationAllowed(
  input: OwnerRevocationInput
): void {
  if (input.role !== "owner" || input.ownerCount > 1) {
    return;
  }

  if (input.targetUserId === input.actorUserId) {
    throw new ApiError(
      409,
      "LAST_OWNER_SELF_REMOVAL_FORBIDDEN",
      "不能撤销自己唯一的 owner 角色。"
    );
  }

  throw new ApiError(
    409,
    "LAST_OWNER_REQUIRED",
    "系统必须至少保留一个 owner。"
  );
}
