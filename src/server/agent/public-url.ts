const MAX_PUBLIC_URL_CHARACTERS = 2_048;

export function parsePublicHttpsUrl(
  value: string,
  expectedHostname?: string
): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.href.length > MAX_PUBLIC_URL_CHARACTERS ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (expectedHostname !== undefined &&
      url.hostname.toLowerCase() !== expectedHostname.toLowerCase()) ||
    hasSensitiveUrlParameters(url)
  ) {
    return undefined;
  }
  url.hash = "";
  return url;
}

export function hasSensitiveUrlParameters(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (
      /^(?:x-amz-|x-oss-)/iu.test(key) ||
      /^(?:signature|ossaccesskeyid|accesskeyid|expires|token)$/iu.test(key)
    ) {
      return true;
    }
  }
  return false;
}
