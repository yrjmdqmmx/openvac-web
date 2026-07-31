export type AccountSessionSummary = {
  id: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string | Date;
  expiresAt: string | Date;
};

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export class SessionManagementUnavailableError extends Error {
  constructor() {
    super("Individual session revocation is not available");
    this.name = "SessionManagementUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function dateValue(value: unknown) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return null;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function parseAccountSessionSummaries(
  value: unknown
): AccountSessionSummary[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string") return [];

    const id = candidate.id.trim();
    const createdAt = dateValue(candidate.createdAt);
    const expiresAt = dateValue(candidate.expiresAt);
    if (!id || !createdAt || !expiresAt) return [];

    return [
      {
        id,
        userAgent: optionalString(candidate.userAgent),
        ipAddress: optionalString(candidate.ipAddress),
        createdAt,
        expiresAt
      }
    ];
  });
}

export async function deleteAccountSession(
  sessionId: string,
  fetchImpl: FetchLike = fetch
) {
  const id = sessionId.trim();
  if (!id) throw new Error("Missing session id");

  const response = await fetchImpl(
    `/api/account/sessions/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json"
      }
    }
  );

  if ([404, 405, 501].includes(response.status)) {
    throw new SessionManagementUnavailableError();
  }

  if (!response.ok) {
    throw new Error("Unable to revoke session");
  }
}
