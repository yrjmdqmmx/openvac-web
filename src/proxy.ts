import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (sessionCookie) return NextResponse.next();

  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const signIn = new URL("/sign-in", request.url);
  signIn.searchParams.set("returnTo", returnTo);
  return NextResponse.redirect(signIn);
}

export const config = {
  matcher: ["/chat/:path*", "/settings/:path*", "/admin/:path*"]
};
