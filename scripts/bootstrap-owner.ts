import { sqlClient } from "../src/server/db";
import {
  bootstrapOwnerByEmail,
  resolveOwnerBootstrapEmail
} from "../src/server/admin/owner-bootstrap";

try {
  const input = resolveOwnerBootstrapEmail(process.argv.slice(2), process.env);
  const result = await bootstrapOwnerByEmail(input);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "owner 初始化失败。");
  process.exitCode = 1;
} finally {
  await sqlClient.end({ timeout: 5 });
}
