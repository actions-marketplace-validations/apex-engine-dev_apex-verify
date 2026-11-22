import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as api from "../src/index.js";
import { run } from "../src/commands.js";
test("new name exported", () => { assert.equal(typeof api.loadItem, "function"); assert.deepEqual(api.loadItem("a"), { id: "a", n: 1 }); assert.equal(api.loadItem("zz"), null); });
test("old name gone from the api", () => assert.equal(api.fetchItem, undefined));
test("command table still works", () => { assert.deepEqual(run("get", "b"), { id: "b", n: 2 }); assert.equal(run("count"), 2); });
test("no leftovers in sources or docs", () => {
  for (const f of ["src/store.js", "src/service.js", "src/commands.js", "src/index.js", "README.md"]) assert.ok(!fs.readFileSync(new URL("../" + f, import.meta.url), "utf8").includes("fetchItem"), f);
});
