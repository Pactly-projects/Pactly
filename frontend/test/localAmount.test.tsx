import test from "node:test";
import assert from "node:assert/strict";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LocalAmount } from "../src/components/LocalAmount";
import { formatLocalAmount } from "../src/lib/money";

function renderWithRate(rate: unknown, amount = "30000000"): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["rate"], rate);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(LocalAmount, { amount })),
  );
}

test("renders the USD code and two decimals from the anchor's fake rate config, with no TRY", () => {
  const markup = renderWithRate({ rate: "1.00", currency: "USD", decimals: 2, quotedAt: 1_700_000_000 });

  assert.match(markup, /3\.00 USD/);
  assert.ok(!markup.includes("TRY"), "the lira code must not appear");
  assert.ok(!markup.includes("₺"), "the lira symbol must not appear");
});

test("decimals follow the anchor instead of a fixed two", () => {
  const markup = renderWithRate({ rate: "150", currency: "JPY", decimals: 0, quotedAt: 1_700_000_000 }, "10000000");

  assert.match(markup, />150 JPY</);
  assert.ok(!markup.includes(".00"));
});

test("a missing or invalid currency config renders a plain error, not a currency fallback", () => {
  const markup = renderWithRate({ rate: "41.20", currency: "", decimals: 2, quotedAt: 1_700_000_000 });

  assert.match(markup, /couldn(?:'|&#x27;)t load the local currency/);
  assert.ok(!markup.includes("TRY"));
  assert.ok(!markup.includes("₺"));
});

test("formatLocalAmount uses the supplied code and decimal places", () => {
  assert.equal(formatLocalAmount("30000000", "1.00", "USD", 2), "3.00 USD");
  assert.equal(formatLocalAmount("10000000", "150", "JPY", 0), "150 JPY");
  assert.equal(formatLocalAmount("10000000", "1.2345", "KWD", 3), "1.235 KWD");
  assert.equal(formatLocalAmount("10000000", "1", "", 2), "");
  assert.equal(formatLocalAmount("10000000", "1", "USD", 2.5), "");
});
