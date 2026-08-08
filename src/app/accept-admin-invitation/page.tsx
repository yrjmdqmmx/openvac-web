import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { InvitationAcceptance } from "@/components/admin/invitation-acceptance";
import { auth } from "@/server/auth";

const INVITATION_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const dynamic = "force-dynamic";

export default async function AcceptAdminInvitationPage({
  searchParams
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token = "" } = await searchParams;
  if (!INVITATION_TOKEN.test(token)) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--surface)] px-6">
        <div className="max-w-md rounded-2xl border border-[var(--border)] bg-white p-8 text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.04em]">
            邀请链接无效
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
            链接缺少有效的一次性邀请凭证，请联系后台管理员重新发送。
          </p>
        </div>
      </main>
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    const returnTo = `/accept-admin-invitation?token=${encodeURIComponent(token)}`;
    redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--surface)] px-6 py-12">
      <InvitationAcceptance token={token} email={session.user.email} />
    </main>
  );
}
