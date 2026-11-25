import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EscrowProof } from "../src/components/EscrowProof.js";

const CONTRACT_ID = "CFAKECONTRACTPROOF0000000000000000000000000000000";
const RELEASE_TX_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("before release the proof links the escrow only", () => {
  const html = renderToStaticMarkup(
    createElement(EscrowProof, { contractId: CONTRACT_ID, released: false, releaseTxHash: null }),
  );

  assert.ok(html.includes(`/explorer/testnet/contract/${CONTRACT_ID}`), "the escrow link stays");
  assert.equal(html.includes("release transaction"), false, "no release link before release");
  assert.equal(html.includes("not recorded yet"), false, "no release note before release");
});

test("after release the proof links both the escrow and the release transaction", () => {
  const html = renderToStaticMarkup(
    createElement(EscrowProof, {
      contractId: CONTRACT_ID,
      released: true,
      releaseTxHash: RELEASE_TX_HASH,
    }),
  );

  assert.ok(html.includes(`/explorer/testnet/contract/${CONTRACT_ID}`), "escrow link is still there");
  assert.ok(html.includes(`/explorer/testnet/tx/${RELEASE_TX_HASH}`), "release tx link is added");
  assert.ok(html.includes("release transaction"), "the link is named in plain language");
});

test("a release with no stored hash says the hash is not recorded yet", () => {
  const html = renderToStaticMarkup(
    createElement(EscrowProof, { contractId: CONTRACT_ID, released: true, releaseTxHash: null }),
  );

  assert.ok(html.includes("not recorded yet"), "the missing hash is stated plainly");
  assert.equal(html.includes("/explorer/testnet/tx/"), false, "no invented transaction link");
});
