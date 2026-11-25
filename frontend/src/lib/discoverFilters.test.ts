import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DISCOVER_SORT,
  applyDiscoverView,
  readDiscoverFilters,
  writeDiscoverFilters,
} from "./discoverFilters.js";

const KNOWN_SLUGS = ["beauty", "wellness"];

test("a fixture URL reads back into the same discovery filters", () => {
  const url = new URLSearchParams(
    "category=beauty&neighborhood=Kadikoy&q=hair&format=in_person&format=video&minPrice=100&maxPrice=500&maxDepositBps=3000&when=week&sort=price-asc",
  );

  const filters = readDiscoverFilters(url, KNOWN_SLUGS);

  assert.deepEqual(filters, {
    category: "beauty",
    neighborhood: "Kadikoy",
    q: "hair",
    formats: ["in_person", "video"],
    minPrice: "100",
    maxPrice: "500",
    maxDepositBps: 3000,
    when: "week",
    sort: "price-asc",
  });
});

test("filters round trip through the URL", () => {
  const filters = readDiscoverFilters(
    new URLSearchParams("neighborhood=Besiktas&format=video&q=cut&sort=price-desc"),
    KNOWN_SLUGS,
  );
  const written = writeDiscoverFilters(filters);
  const reread = readDiscoverFilters(written, KNOWN_SLUGS);

  assert.deepEqual(reread, filters);
  assert.equal(written.get("neighborhood"), "Besiktas");
  assert.equal(written.get("sort"), "price-desc");
});

test("an unknown category in the URL is ignored", () => {
  const filters = readDiscoverFilters(new URLSearchParams("category=not-a-real-slug"), KNOWN_SLUGS);
  assert.equal(filters.category, undefined);
});

test("an unknown sort falls back to the default and is not written", () => {
  const filters = readDiscoverFilters(new URLSearchParams("sort=random"), KNOWN_SLUGS);
  assert.equal(filters.sort, DEFAULT_DISCOVER_SORT);
  assert.equal(writeDiscoverFilters(filters).get("sort"), null);
});

test("invalid price and deposit bounds are ignored", () => {
  const filters = readDiscoverFilters(
    new URLSearchParams("minPrice=-1&maxPrice=1.5&maxDepositBps=0"),
    KNOWN_SLUGS,
  );
  assert.equal(filters.minPrice, undefined);
  assert.equal(filters.maxPrice, undefined);
  assert.equal(filters.maxDepositBps, undefined);
});

test("the neighbourhood filter narrows the cards and is case insensitive", () => {
  const cards = [
    { location: "Kadikoy, Istanbul", price: { amount: "200" } },
    { location: "Besiktas, Istanbul", price: { amount: "100" } },
  ];

  const visible = applyDiscoverView(cards, "kadikoy", DEFAULT_DISCOVER_SORT);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]!.location, "Kadikoy, Istanbul");
});

test("the sort orders cards by price while soonest keeps the backend order", () => {
  const cards = [
    { location: "A", price: { amount: "300" } },
    { location: "B", price: { amount: "100" } },
    { location: "C", price: { amount: "200" } },
  ];

  assert.deepEqual(
    applyDiscoverView(cards, "", "price-asc").map((card) => card.location),
    ["B", "C", "A"],
  );
  assert.deepEqual(
    applyDiscoverView(cards, "", "price-desc").map((card) => card.location),
    ["A", "C", "B"],
  );
  assert.deepEqual(
    applyDiscoverView(cards, "", DEFAULT_DISCOVER_SORT).map((card) => card.location),
    ["A", "B", "C"],
  );
});
