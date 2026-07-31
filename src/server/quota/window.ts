import type { QuotaWindow } from "./types";

export const QUOTA_TIME_ZONE = "Asia/Shanghai";
const SHANGHAI_UTC_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: QUOTA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function dateParts(at: Date) {
  const parts = Object.fromEntries(
    dateFormatter
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  if (!parts.year || !parts.month || !parts.day) {
    throw new Error("Unable to resolve the Shanghai quota window");
  }

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day
  };
}

export function shanghaiDailyWindow(at = new Date()): QuotaWindow {
  if (Number.isNaN(at.getTime())) {
    throw new TypeError("Quota window date must be valid");
  }

  const { year, month, day } = dateParts(at);
  const key = [
    year.toString().padStart(4, "0"),
    month.toString().padStart(2, "0"),
    day.toString().padStart(2, "0")
  ].join("-");
  const nextLocalMidnightAsUtc = Date.UTC(year, month - 1, day + 1);

  return {
    key,
    resetAt: new Date(nextLocalMidnightAsUtc - SHANGHAI_UTC_OFFSET_MILLISECONDS)
  };
}
