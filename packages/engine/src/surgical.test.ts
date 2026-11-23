import assert from "node:assert/strict";
import test from "node:test";
import { requestOnly } from "./index.js";

test("a checks answer that repeats setup lines is kept; one cut before its end keeps its complete tests", async () => {
  const { checkCode, repeatsALine } = await import("./index.js");
  const file = 'import { test } from "node:test";\ntest("a", () => {\n  const s = createStore();\n});\ntest("b", () => {\n  const s = createStore();\n});\ntest("c", () => {\n  const s = createStore();\n});';
  assert.equal(repeatsALine(file, 8), false, "three tests with the same setup line are not a loop");
  assert.equal(repeatsALine(Array(9).fill("  const s = createStore();").join("\n"), 8), true);
  assert.equal(checkCode("```js\n" + file + "\n```"), file);
  const cut = "```js\n" + file + '\ntest("d", () => {\n  const s = crea';
  assert.equal(checkCode(cut), file, "the unfinished last test is dropped");
  assert.equal(checkCode("no code here"), "");
});

test("requestOnly drops the code-graph callers note, so its file paths are not read as files the request names", () => {
  const task = "Fix `add`.\n\n<code-graph-callers>\nCallers:\n- add() (src/add.js:1) is used by src/main.js:3 run\n</code-graph-callers>";
  assert.equal(requestOnly(task), "Fix `add`.");
});

test("a fence line inside a Python triple-quoted string does not end the checks file", async () => {
  const { checkCode, hasFencedBlock } = await import("./surgical.js");
  const code = 'def test_md():\n    doc = """\n```\ncode\n```\n"""\n    assert render(doc)\n';
  assert.equal(checkCode("```python\n" + code + "```\n"), code.replace(/\n$/, ""));
  assert.equal(hasFencedBlock("```python\ndef test_md():\n    doc = \"\"\"\n```\ncode\n"), false, "still open: the fence is inside the string");
  assert.equal(checkCode("```js\nconst a = 1;\n```\nmore text"), "const a = 1;");
});
