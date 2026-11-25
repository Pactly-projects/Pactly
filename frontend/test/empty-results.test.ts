import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmptyResults, type EmptyResultsProps } from "../src/components/EmptyResults.js";

function renderEmptyResults(overrides: Partial<EmptyResultsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(EmptyResults, {
      query: "",
      filterChips: [],
      onClearFilter: () => {},
      hasAvailabilityFilter: false,
      onClearAvailability: () => {},
      browseLabel: "Browse all providers",
      onBrowseWider: () => {},
      ...overrides,
    }),
  );
}

test("the empty state echoes the fixture query the client searched for", () => {
  const html = renderEmptyResults({ query: "beard trim" });
  assert.ok(html.includes("beard trim"), "the query must be visible in the empty state");
  assert.ok(html.includes("No results for"), "the empty state names the failed search");
});

test("a query of only spaces is treated as empty", () => {
  const html = renderEmptyResults({ query: "   " });
  assert.equal(html.includes("No results for"), false, "whitespace is not echoed as a query");
  assert.ok(html.includes("No providers match these filters."));
});
