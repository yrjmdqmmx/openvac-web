import { inspectAuthConfig } from "../src/server/auth/config-preflight";

const report = inspectAuthConfig(process.env);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
