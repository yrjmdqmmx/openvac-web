import { createHmac } from "node:crypto";

import { ConfigurationError } from "./errors";
import { requireString } from "./runtime";

const PROVIDER_ID = "deepseek";

export function createDeepSeekUserPartition(
  subject: string,
  secret: string
): string {
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) {
    throw new TypeError("A stable internal subject is required.");
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new ConfigurationError(
      PROVIDER_ID,
      "DEEPSEEK_USER_PARTITION_SECRET must contain at least 32 bytes."
    );
  }

  const digest = createHmac("sha256", secret)
    .update("openvac.deepseek.user.v1\0", "utf8")
    .update(normalizedSubject, "utf8")
    .digest("base64url");
  return `ov1_${digest}`;
}

export function getDeepSeekUserPartition(subject: string): string {
  const secret = requireString(
    PROVIDER_ID,
    "DEEPSEEK_USER_PARTITION_SECRET",
    process.env.DEEPSEEK_USER_PARTITION_SECRET
  );
  return createDeepSeekUserPartition(subject, secret);
}
