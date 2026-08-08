type ConfigEnvironment = Record<string, string | undefined>;

export interface AuthConfigCheck {
  name: "betterAuthUrl" | "trustedOrigins" | "betterAuthSecret" | "directMail";
  present: boolean;
  valid: boolean;
}

export interface AuthConfigPreflightReport {
  ok: boolean;
  checks: AuthConfigCheck[];
}

function present(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function validHttpUrl(value: string | undefined, requireOrigin = false) {
  if (!present(value)) return false;
  try {
    const url = new URL(value!);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!requireOrigin ||
        (url.pathname === "/" && url.toString() === url.origin + "/"))
    );
  } catch {
    return false;
  }
}

function validTrustedOrigins(
  value: string | undefined,
  betterAuthUrl: string | undefined
): boolean {
  if (!present(value)) return false;
  const origins = value!
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    origins.length === 0 ||
    !origins.every((origin) => validHttpUrl(origin, true)) ||
    !validHttpUrl(betterAuthUrl, true)
  ) {
    return false;
  }

  const authOrigin = new URL(betterAuthUrl!).origin;
  return origins.some((origin) => new URL(origin).origin === authOrigin);
}

function validEmail(value: string | undefined): boolean {
  return present(value) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value!.trim());
}

function validHostname(value: string | undefined): boolean {
  if (!present(value)) return true;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
    value!.trim()
  );
}

export function inspectAuthConfig(
  environment: ConfigEnvironment
): AuthConfigPreflightReport {
  const directMailAccessKeyId =
    environment.ALIBABA_DIRECTMAIL_ACCESS_KEY_ID ??
    environment.ALIBABA_ACCESS_KEY_ID;
  const directMailAccessKeySecret =
    environment.ALIBABA_DIRECTMAIL_ACCESS_KEY_SECRET ??
    environment.ALIBABA_ACCESS_KEY_SECRET;
  const directMailRequired = [
    directMailAccessKeyId,
    directMailAccessKeySecret,
    environment.ALIBABA_DIRECTMAIL_ACCOUNT_NAME
  ];
  const directMailPresent = directMailRequired.every(present);

  const checks: AuthConfigCheck[] = [
    {
      name: "betterAuthUrl",
      present: present(environment.BETTER_AUTH_URL),
      valid: validHttpUrl(environment.BETTER_AUTH_URL, true)
    },
    {
      name: "trustedOrigins",
      present: present(environment.AUTH_TRUSTED_ORIGINS),
      valid: validTrustedOrigins(
        environment.AUTH_TRUSTED_ORIGINS,
        environment.BETTER_AUTH_URL
      )
    },
    {
      name: "betterAuthSecret",
      present: present(environment.BETTER_AUTH_SECRET),
      valid: (environment.BETTER_AUTH_SECRET?.trim().length ?? 0) >= 32
    },
    {
      name: "directMail",
      present: directMailPresent,
      valid:
        directMailPresent &&
        validEmail(environment.ALIBABA_DIRECTMAIL_ACCOUNT_NAME) &&
        validHostname(environment.ALIBABA_DIRECTMAIL_ENDPOINT) &&
        (!present(environment.ALIBABA_DIRECTMAIL_REGION) ||
          /^[a-z0-9-]+$/iu.test(environment.ALIBABA_DIRECTMAIL_REGION!.trim()))
    }
  ];

  return {
    ok: checks.every((check) => check.present && check.valid),
    checks
  };
}
