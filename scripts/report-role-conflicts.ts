import { apiStore } from "@/server/api/store";

async function main() {
  const report = await apiStore.reportAdminRoleConflicts();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
