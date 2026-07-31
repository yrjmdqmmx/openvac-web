import manifest from "../knowledge/source-manifest.json";
import { eq } from "drizzle-orm";
import { db } from "../src/server/db";
import { knowledgeSources } from "../src/server/db/schema";

type SourceManifestItem = (typeof manifest)[number];

for (const source of manifest as SourceManifestItem[]) {
  const existing = await db
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.canonicalUrl, source.canonicalUrl))
    .limit(1);

  const values = {
    kind: source.kind,
    name: source.name,
    publisher: source.publisher,
    canonicalUrl: source.canonicalUrl,
    baseUrl: source.baseUrl,
    sourceTier: source.sourceTier,
    licensePolicy: source.licensePolicy,
    trustLevel: source.trustLevel,
    enabled: source.enabled,
    notes: source.notes,
    metadata: {
      sourceKey: source.sourceKey,
      seededBy: "knowledge/source-manifest.json",
      rightsReviewed: false
    },
    updatedAt: new Date()
  } as typeof knowledgeSources.$inferInsert;

  if (existing[0]) {
    await db
      .update(knowledgeSources)
      .set(values)
      .where(eq(knowledgeSources.id, existing[0].id));
  } else {
    await db.insert(knowledgeSources).values(values);
  }
}

console.log(`Seeded ${manifest.length} governed source records.`);
