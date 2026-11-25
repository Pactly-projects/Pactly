import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReceivingAddress } from "../src/components/ReceivingAddress.js";

const ADDRESS = "GSHOPRECEIVINGADDRESS0000000000000000000000000000000000";

test("the booking shows the fixture receiving address with a copy control", () => {
  const html = renderToStaticMarkup(createElement(ReceivingAddress, { address: ADDRESS }));

  assert.ok(html.includes("Shop receiving address"));
  assert.ok(html.includes(`title="${ADDRESS}"`), "the full address is available on the row");
  assert.ok(html.includes("GSHO"), "the shortened address is visible");
  assert.ok(html.includes("Copy"), "the address can be copied");
});

test("a missing address says it is unset", () => {
  for (const address of [null, undefined, ""] as const) {
    const html = renderToStaticMarkup(createElement(ReceivingAddress, { address }));
    assert.ok(html.includes("Not set yet"), `missing address (${String(address)}) must read as unset`);
    assert.equal(html.includes("Copy"), false, "there is nothing to copy");
  }
});
