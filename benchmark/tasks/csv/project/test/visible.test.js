import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../src/csv.js";
test("plain", () => assert.deepEqual(parseCSV("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]));
test("quoted comma", () => assert.deepEqual(parseCSV('x,"Smith, John",y\n'), [["x", "Smith, John", "y"]]));
