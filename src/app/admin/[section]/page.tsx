import { notFound } from "next/navigation";
import {
  AdminModuleTable,
  type AdminSection
} from "@/components/admin/module-table";

const sections: AdminSection[] = [
  "users",
  "conversations",
  "consultations",
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
  return <AdminModuleTable section={section as AdminSection} />;
}
