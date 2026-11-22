import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";
test("punctuation", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("accents", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));
test("collapses separators", () => assert.equal(slugify("a  --  b___c"), "a-b-c"));
test("trims dashes", () => assert.equal(slugify("  --Hi!--  "), "hi"));
test("digits", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));
test("empty", () => { assert.equal(slugify(""), ""); assert.equal(slugify("!!!"), ""); });
