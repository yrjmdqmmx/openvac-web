import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  try {
    await Promise.race([
      db.execute(sql`select 1 as ok`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database timeout")), 1500)
      )
    ]);

    return NextResponse.json({
      status: "ok",
      service: "openvac-web",
      database: "ready",
      elapsedMs: Date.now() - startedAt,
      timestamp: new Date().toISOString()
    });
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        service: "openvac-web",
        database: "unavailable",
        elapsedMs: Date.now() - startedAt,
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    );
  }
}
