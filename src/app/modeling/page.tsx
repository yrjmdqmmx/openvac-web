import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ModelingWorkspace } from "@/components/modeling/modeling-workspace";
import { auth } from "@/server/auth";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";
import { isModelingEnabled } from "@/server/modeling/feature-flag";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "智能建模",
  description: "OpenVac 参数化真空泵手动建模工作区"
};

export default async function ModelingPage({
  searchParams
}: {
  searchParams: Promise<{ project?: string | string[] }>;
}) {
  if (!isModelingEnabled()) {
    notFound();
  }
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/sign-in?returnTo=%2Fmodeling");
  }
  const query = await searchParams;
  const initialProjectId =
    typeof query.project === "string" ? query.project.trim() : undefined;

  return (
    <ModelingWorkspace
      userName={session.user.name || "OpenVac 用户"}
      userId={session.user.id}
      initialProjectId={initialProjectId || undefined}
      initialTemplate={createRotaryVanePumpTemplate({
        documentId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        name: "原创单级旋片泵",
        parameters: { eccentricity: 8 }
      })}
    />
  );
}
