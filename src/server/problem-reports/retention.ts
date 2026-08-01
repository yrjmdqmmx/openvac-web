import { and, isNotNull, lte } from "drizzle-orm";

import { db } from "@/server/db";
import { problemReports } from "@/server/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

export function problemReportRetentionUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + 180 * DAY_MS);
}

export function problemReportContactPurgeAt(closedAt: Date): Date {
  return new Date(closedAt.getTime() + 30 * DAY_MS);
}

export async function cleanupExpiredProblemReportData(
  now = new Date()
): Promise<{ contactsPurged: number; reportsDeleted: number }> {
  return db.transaction(async (tx) => {
    const purged = await tx
      .update(problemReports)
      .set({ contactType: null, contactValue: null, updatedAt: now })
      .where(
        and(
          isNotNull(problemReports.contactPurgeAt),
          lte(problemReports.contactPurgeAt, now),
          isNotNull(problemReports.contactValue)
        )
      )
      .returning({ id: problemReports.id });

    const deleted = await tx
      .delete(problemReports)
      .where(lte(problemReports.retentionUntil, now))
      .returning({ id: problemReports.id });

    return {
      contactsPurged: purged.length,
      reportsDeleted: deleted.length
    };
  });
}
