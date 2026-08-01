import { cleanupExpiredProblemReportData } from "@/server/problem-reports/retention";

const result = await cleanupExpiredProblemReportData();

console.log(
  `Problem-report cleanup complete: ${result.contactsPurged} contacts purged, ${result.reportsDeleted} expired reports deleted.`
);
