import test from "node:test";
import assert from "node:assert/strict";
import { engineSettings, GRAPH_CHECKS_THINKING, GRAPH_EDIT_THINKING, CHECKS_BUDGET, SCOPED_BUDGET } from "./index.js";

test("engine options: no options and an empty environment give the measured defaults", () => {
  const s = engineSettings({ env: {} });
  assert.equal(s.graphThinking("edit"), GRAPH_EDIT_THINKING);
  assert.equal(s.graphThinking("checks"), GRAPH_CHECKS_THINKING);
  assert.equal(s.surgicalThinking(), undefined);
  assert.equal(s.slimChecks(), true);
  assert.equal(s.scopedBudget(), SCOPED_BUDGET);
  assert.equal(s.checksBudget(), CHECKS_BUDGET);
  assert.equal(s.versionCallSeconds(), 0);
  assert.equal(s.debugDir(), undefined);
});

test("engine options: the APEX_* variables stay as aliases, and an option wins over them", () => {
  const env = { APEX_GRAPH_THINKING: "default", APEX_GRAPH_CHECKS_THINKING: "512", APEX_SURGICAL_THINKING: "300", APEX_GRAPH_CHECKS_CONTEXT: "full", APEX_GRAPH_SCOPED_BUDGET: "9000", APEX_GRAPH_CHECKS_BUDGET: "100", APEX_VERSION_CALL_SEC: "20", APEX_VERSIONS_MAX_SEC: "40", APEX_SURGICAL_DEBUG: "/tmp/x" };
  const s = engineSettings({ env });
  assert.equal(s.graphThinking("edit"), undefined);
  assert.equal(s.graphThinking("checks"), 512);
  assert.equal(s.surgicalThinking(), 300);
  assert.equal(s.slimChecks(), false);
  assert.equal(s.scopedBudget(), 9000);
  assert.equal(s.checksBudget(), CHECKS_BUDGET, "a budget under 2000 is ignored, as before");
  assert.equal(s.versionCallSeconds(), 20);
  assert.equal(s.versionsMaxSeconds(), 40);
  assert.equal(s.debugDir(), "/tmp/x");
  const o = engineSettings({ env, graphEditThinking: 4096, graphChecksThinking: "default", surgicalThinking: 0, checksContext: "slim", scopedBudget: 5000, versionCallSeconds: 5, debugDir: "/d", secretMark: "[[" });
  assert.equal(o.graphThinking("edit"), 4096);
  assert.equal(o.graphThinking("checks"), undefined);
  assert.equal(o.surgicalThinking(), 0);
  assert.equal(o.slimChecks(), true);
  assert.equal(o.scopedBudget(), 5000);
  assert.equal(o.versionCallSeconds(), 5);
  assert.equal(o.debugDir(), "/d");
  assert.equal(o.secretMark(), "[[");
});
