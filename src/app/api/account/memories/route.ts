import { and, asc, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { auth } from "@/server/auth";
import { assertAccountWritable } from "@/server/auth/account-write-barrier";
import { db } from "@/server/db";
import { conversations, messages, userMemories } from "@/server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  kind: z.enum(["equipment", "operating_context", "unit_preference"]),
  label: z.string().trim().min(1).max(120),
  facts: z.record(z.string().min(1).max(120), z.unknown()),
  sourceMessageIds: z.array(z.string().uuid()).max(20).default([])
});

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error(401, "UNAUTHENTICATED", "请先登录。");
  const rows = await db
    .select()
    .from(userMemories)
    .where(eq(userMemories.userId, session.user.id))
    .orderBy(asc(userMemories.createdAt));
  return Response.json({ data: { memories: rows } });
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return error(401, "UNAUTHENTICATED", "请先登录。");
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || byteLength(parsed.data?.facts) > 16 * 1024) {
    return error(400, "INVALID_MEMORY", "记忆内容格式不正确或超过 16 KiB。");
  }
  try {
    const created = await db.transaction(async (tx) => {
      await assertAccountWritable(tx, session.user.id);
      const [{ value }] = await tx
        .select({ value: count() })
        .from(userMemories)
        .where(eq(userMemories.userId, session.user.id));
      if ((value ?? 0) >= 100) throw new MemoryLimitError();
      if (parsed.data.sourceMessageIds.length > 0) {
        const owned = await tx
          .select({ id: messages.id })
          .from(messages)
          .innerJoin(
            conversations,
            eq(messages.conversationId, conversations.id)
          )
          .where(
            and(
              eq(conversations.userId, session.user.id),
              inArray(messages.id, parsed.data.sourceMessageIds)
            )
          );
        if (owned.length !== new Set(parsed.data.sourceMessageIds).size) {
          throw new InvalidMemorySourceError();
        }
      }
      const [row] = await tx
        .insert(userMemories)
        .values({
          userId: session.user.id,
          kind: parsed.data.kind,
          label: parsed.data.label,
          facts: parsed.data.facts,
          sourceMessageIds: [...new Set(parsed.data.sourceMessageIds)]
        })
        .returning();
      return row;
    });
    return Response.json({ data: { memory: created } }, { status: 201 });
  } catch (caught) {
    if (caught instanceof MemoryLimitError) {
      return error(409, "MEMORY_LIMIT", "最多可保存 100 条主动记忆。");
    }
    if (caught instanceof InvalidMemorySourceError) {
      return error(
        403,
        "INVALID_MEMORY_SOURCE",
        "记忆来源消息不属于当前账号。"
      );
    }
    return error(409, "MEMORY_WRITE_BLOCKED", "暂时无法保存此记忆。");
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

class MemoryLimitError extends Error {}
class InvalidMemorySourceError extends Error {}
