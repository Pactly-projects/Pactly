import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { categories } from "./schema.js";

export type CategoryRow = typeof categories.$inferSelect;

export async function getCategoryById(db: Db, id: string): Promise<CategoryRow | undefined> {
  const rows = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
  return rows[0];
}

/** Story 3.2: `GET /providers?category=<slug>` resolves the URL's slug to
 * a category id here first -- an unknown slug returns `undefined`, which
 * `services/profile.ts`'s `listDiscoverProviders` turns into an empty list
 * rather than an error (the spec's own "Unknown slug" row). */
export async function getCategoryBySlug(db: Db, slug: string): Promise<CategoryRow | undefined> {
  const rows = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
  return rows[0];
}

export async function listCategories(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories);
}

/** Story 5.8: returns only visible categories. */
export async function listVisibleCategories(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories).where(eq(categories.visible, true));
}

/** Story 5.8: creates a new category with the given name and slug. */
export async function insertCategory(db: Db, values: { id: string; name: string; slug: string }): Promise<void> {
  await db.insert(categories).values({
    id: values.id,
    name: values.name,
    slug: values.slug,
    visible: true,
  });
}

/** Story 5.8: toggles a category's visibility. */
export async function updateCategoryVisibility(db: Db, id: string, visible: boolean): Promise<void> {
  await db.update(categories).set({ visible }).where(eq(categories.id, id));
}
