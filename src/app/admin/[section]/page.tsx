import { notFound } from "next/navigation";
import {
  AdminModuleTable,
  type AdminSection
} from "@/components/admin/module-table";
import {
  AdminsManager,
  BudgetManager,
  ConversationsManager,
  FeedbackManager,
  ProblemReportsManager,
  UsersManager
} from "@/components/admin/core-operations";
import { PromptsManager } from "@/components/admin/prompts-manager";
import { SourcesManager } from "@/components/admin/sources-manager";

const sections: AdminSection[] = [
  "users",
  "conversations",
  "feedback",
  "problem-reports",
  "sources",
  "prompts",
  "models",
  "admins",
  "audit"
];

export default async function AdminSectionPage({
  params
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!sections.includes(section as AdminSection)) {
    notFound();
  }
  if (section === "users") return <UsersManager />;
  if (section === "conversations") return <ConversationsManager />;
  if (section === "feedback") return <FeedbackManager />;
  if (section === "problem-reports") return <ProblemReportsManager />;
  if (section === "admins") return <AdminsManager />;
  if (section === "models") return <BudgetManager />;
  if (section === "sources") return <SourcesManager />;
  if (section === "prompts") return <PromptsManager />;
  return <AdminModuleTable section={section as AdminSection} />;
}
