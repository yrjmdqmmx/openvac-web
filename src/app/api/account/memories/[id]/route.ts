import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/server/auth";
import { assertAccountWritable } from "@/server/auth/account-write-barrier";
import { db } from "@/server/db";
import { userMemories } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    facts: z.record(z.string().min(1).max(120), z.unknown()).optional(),
    status: z.enum(["active", "disabled"]).optional()
  })
  .refine((value) => Object.keys(value).length > 0);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error(401, "UNAUTHENTICATED", "请先登录。");
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return error(400, "INVALID_MEMORY_ID", "记忆标识不正确。");
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (
    !parsed.success ||
    (parsed.data.facts && byteLength(parsed.data.facts) > 16 * 1024)
  ) {
    return error(400, "INVALID_MEMORY", "记忆内容格式不正确或超过 16 KiB。");
  }
  try {
    const [updated] = await db.transaction(async (tx) => {
      await assertAccountWritable(tx, session.user.id);
      return tx
        .update(userMemories)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(
          and(eq(userMemories.id, id), eq(userMemories.userId, session.user.id))
        )
        .returning();
    });
    if (!updated) return error(404, "MEMORY_NOT_FOUND", "这条记忆不存在。");
    return Response.json({ data: { memory: updated } });
  } catch {
    return error(409, "MEMORY_WRITE_BLOCKED", "暂时无法修改此记忆。");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error(401, "UNAUTHENTICATED", "请先登录。");
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) {
    return error(400, "INVALID_MEMORY_ID", "记忆标识不正确。");
  }
  try {
    const [deleted] = await db.transaction(async (tx) => {
      await assertAccountWritable(tx, session.user.id);
      return tx
        .delete(userMemories)
        .where(
          and(eq(userMemories.id, id), eq(userMemories.userId, session.user.id))
        )
        .returning({ id: userMemories.id });
    });
    if (!deleted) return error(404, "MEMORY_NOT_FOUND", "这条记忆不存在。");
    return new Response(null, { status: 204 });
  } catch {
    return error(409, "MEMORY_DELETE_BLOCKED", "暂时无法删除此记忆。");
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}
