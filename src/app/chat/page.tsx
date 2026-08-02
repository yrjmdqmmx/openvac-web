import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ChatWorkspace } from "@/components/chat/chat-workspace";
import { auth } from "@/server/auth";
import { isModelingEnabled } from "@/server/modeling/feature-flag";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session) {
    redirect("/sign-in?returnTo=%2Fchat");
  }

  return (
    <ChatWorkspace
      userId={session.user.id}
      userName={session.user.name || "OpenVac 用户"}
      userEmail={session.user.email}
      modelingEnabled={isModelingEnabled()}
    />
  );
}
