import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { auditToolContract, routerPolicyManifest } from "../src/contract-audit.mjs";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const policy = routerPolicyManifest();
const contract = {
  schemaVersion: 1,
  service: "toolbox-mcp",
  version: "test",
  groups: [],
  tools: policy.tools.map(({ name }) => ({
    name,
    group: "system",
    description: name,
    inputSchema: { type: "object", properties: {} },
    annotations: { ...annotations },
  })),
};
const discovered = contract.tools.map(({ name, inputSchema, annotations: hints }) => ({
  name,
  inputSchema,
  annotations: { ...hints },
}));

test("router policy manifest is deterministic and explicitly classifies every tool", () => {
  assert.equal(policy.service, "toolbox-router");
  assert.equal(policy.tools.length, 37);
  assert.deepEqual(policy, routerPolicyManifest());
  assert.equal(policy.tools.find((tool) => tool.name === "gmail_connect")?.classification, "blocked");
  assert.equal(policy.tools.find((tool) => tool.name === "widgets_import")?.classification, "restricted");
  assert.equal(policy.tools.find((tool) => tool.name === "system_stats")?.classification, "auto");
});

test("aligned contract and discovery produce a stable digest", () => {
  const result = auditToolContract(contract, discovered, policy);

  assert.equal(result.ok, true);
  assert.equal(result.status, "aligned");
  assert.match(result.policyDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.missingFromPolicy, []);
  assert.deepEqual(result.missingFromDiscovery, []);
  assert.deepEqual(result.missingFromContract, []);
  assert.deepEqual(result.annotationDrift, []);
});

test("new missing and annotation-drifted tools are detected without reclassification", () => {
  const changed = structuredClone(contract);
  changed.tools.push({
    name: "new_admin_tool",
    group: "system",
    description: "new",
    inputSchema: { type: "object", properties: {} },
    annotations: { ...annotations },
  });
  changed.tools = changed.tools.filter((tool) => tool.name !== "system_stats");
  const changedDiscovery = discovered.filter((tool) => tool.name !== "system_stats");
  const result = auditToolContract(changed, changedDiscovery, policy);

  assert.equal(result.ok, false);
  assert.equal(result.status, "drift");
  assert.deepEqual(result.missingFromPolicy, ["new_admin_tool"]);
  assert.deepEqual(result.missingFromDiscovery, ["system_stats"]);
  assert.deepEqual(result.missingFromContract, ["system_stats"]);
  assert.equal(policy.tools.some((tool) => tool.name === "new_admin_tool"), false);
});

test("dynamic discoveries are reported but never added to policy", () => {
  const result = auditToolContract(
    contract,
    [...discovered, { name: "remote_dynamic_shell" }],
    policy,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ignoredDynamicTools, ["remote_dynamic_shell"]);
  assert.equal(policy.tools.some((tool) => tool.name === "remote_dynamic_shell"), false);
});

test("malformed contracts and annotation changes fail closed", () => {
  assert.equal(auditToolContract(null, discovered, policy).status, "invalid");
  const changed = structuredClone(contract);
  changed.tools[0].annotations.readOnlyHint = false;
  const result = auditToolContract(changed, discovered, policy);

  assert.equal(result.ok, false);
  assert.equal(result.annotationDrift.length, 1);
  assert.equal(
    result.policyDigest,
    createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
  );
});

test("input schema drift between contract and discovery fails closed", () => {
  const changedDiscovery = structuredClone(discovered);
  const target = changedDiscovery.find((tool) => tool.name === "system_stats");
  target.inputSchema = { type: "object", properties: { injected: { type: "string" } } };
  const result = auditToolContract(contract, changedDiscovery, policy);
  assert.equal(result.ok, false);
  assert.equal(result.status, "drift");
  assert.deepEqual(result.schemaDrift, ["system_stats"]);
});

test("schema property order alone is not drift", () => {
  const reordered = structuredClone(discovered);
  const target = reordered.find((tool) => tool.name === "system_stats");
  target.inputSchema = { properties: {}, type: "object" };
  const result = auditToolContract(contract, reordered, policy);
  assert.equal(result.ok, true);
  assert.deepEqual(result.schemaDrift, []);
});
