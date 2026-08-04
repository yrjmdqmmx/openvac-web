import {
  cleanupExpiredAgentToolCalls,
  recoverStaleAgentRuns
} from "@/server/agent/retention";
import { cleanupExpiredProblemReportData } from "@/server/problem-reports/retention";

const result = await cleanupExpiredProblemReportData();
const agentTools = await cleanupExpiredAgentToolCalls();
const staleRuns = await recoverStaleAgentRuns();

console.log(
  `Retention cleanup complete: ${result.contactsPurged} problem-report contacts purged, ${result.reportsDeleted} expired problem reports deleted, ${agentTools.deleted} expired Agent tool-call records deleted, ${staleRuns.recovered} interrupted Agent runs recovered.`
);
