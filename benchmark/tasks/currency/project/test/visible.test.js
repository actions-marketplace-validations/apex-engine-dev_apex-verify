import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../src/money.js";
test("usd", () => assert.equal(formatMoney(123456, "USD"), "$1,234.56"));
test("eur", () => assert.equal(formatMoney(500, "EUR"), "€5.00"));
