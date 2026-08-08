import { createHash } from "node:crypto";

export function accountAvatarObjectKey(userId: string): string {
  const partition = createHash("sha256").update(userId, "utf8").digest("hex");
  return `account-avatars/${partition}/avatar.webp`;
}
