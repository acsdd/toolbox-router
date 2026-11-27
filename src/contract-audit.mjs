import { createHash } from "node:crypto";

import {
  BRIDGE_TOOL_NAMES,
  CREDENTIAL_TOOL_NAMES,
  classifyTool,
} from "./tool-policy.mjs";

const ANNOTATION_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
];

export function routerPolicyManifest() {
  const names = [...new Set([...BRIDGE_TOOL_NAMES, ...CREDENTIAL_TOOL_NAMES])].sort();
  return {
    schemaVersion: 1,
    service: "toolbox-router",
    tools: names.map((name) => ({ name, classification: classifyTool(name) })),
  };
}

function policyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function schemaFingerprint(schema) {
  return createHash("sha256").update(JSON.stringify(canonicalize(schema ?? {}))).digest("hex");
}

function unavailableAudit(discoveredTools, policy) {
  return {
    ok: false,
    status: "unavailable",
    policyDigest: policyDigest(policy),
    contractVersion: null,
    discoveredCount: Array.isArray(discoveredTools) ? discoveredTools.length : 0,
    exposedCount: 0,
    missingFromDiscovery: [],
    missingFromContract: [],
    missingFromPolicy: [],
    annotationDrift: [],
    schemaDrift: [],
    ignoredDynamicTools: [],
  };
}

function validContract(contract) {
  return (
    contract?.schemaVersion === 1 &&
    contract?.service === "toolbox-mcp" &&
    typeof contract.version === "string" &&
    Array.isArray(contract.groups) &&
    Array.isArray(contract.tools) &&
    contract.tools.every(
      (tool) =>
        typeof tool?.name === "string" &&
        /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(tool.name) &&
        typeof tool.group === "string" &&
        typeof tool.description === "string" &&
        tool.inputSchema &&
        typeof tool.inputSchema === "object" &&
        !Array.isArray(tool.inputSchema) &&
        tool.annotations &&
        ANNOTATION_KEYS.every((key) => typeof tool.annotations[key] === "boolean"),
    )
  );
}

export function auditToolContract(contract, discoveredTools, policy = routerPolicyManifest()) {
  const digest = policyDigest(policy);
  if (contract === undefined) return unavailableAudit(discoveredTools, policy);
  if (!validContract(contract)) {
    return {
      ok: false,
      status: "invalid",
      policyDigest: digest,
      contractVersion: null,
      discoveredCount: Array.isArray(discoveredTools) ? discoveredTools.length : 0,
      exposedCount: 0,
      missingFromDiscovery: [],
      missingFromContract: [],
      missingFromPolicy: [],
      annotationDrift: [],
      schemaDrift: [],
      ignoredDynamicTools: [],
    };
  }

  const policyNames = new Set(policy.tools.map((tool) => tool.name));
  const contractByName = new Map(contract.tools.map((tool) => [tool.name, tool]));
  const discoveredByName = new Map(
    (Array.isArray(discoveredTools) ? discoveredTools : [])
      .filter((tool) => typeof tool?.name === "string")
      .map((tool) => [tool.name, tool]),
  );
  const missingFromPolicy = contract.tools
    .map((tool) => tool.name)
    .filter((name) => !policyNames.has(name))
    .sort();
  const missingFromDiscovery = policy.tools
    .map((tool) => tool.name)
    .filter((name) => !discoveredByName.has(name))
    .sort();
  const missingFromContract = policy.tools
    .map((tool) => tool.name)
    .filter((name) => !contractByName.has(name))
    .sort();
  const annotationDrift = [...contractByName.values()]
    .filter(
      (tool) =>
        discoveredByName.has(tool.name) &&
        ANNOTATION_KEYS.some(
          (key) => discoveredByName.get(tool.name).annotations?.[key] !== tool.annotations[key],
        ),
    )
    .map((tool) => tool.name)
    .sort();
  const schemaDrift = [...contractByName.values()]
    .filter((tool) => {
      const found = discoveredByName.get(tool.name);
      return found && schemaFingerprint(found.inputSchema) !== schemaFingerprint(tool.inputSchema);
    })
    .map((tool) => tool.name)
    .sort();
  const ignoredDynamicTools = [...discoveredByName.keys()]
    .filter((name) => !policyNames.has(name))
    .sort();
  const issues = [
    ...missingFromPolicy,
    ...missingFromDiscovery,
    ...missingFromContract,
    ...annotationDrift,
    ...schemaDrift,
  ];

  return {
    ok: issues.length === 0,
    status: issues.length ? "drift" : "aligned",
    policyDigest: digest,
    contractVersion: contract.version,
    discoveredCount: discoveredByName.size,
    exposedCount: policy.tools.filter(
      (tool) => tool.classification !== "blocked" && discoveredByName.has(tool.name),
    ).length,
    missingFromDiscovery,
    missingFromPolicy,
    missingFromContract,
    annotationDrift,
    schemaDrift,
    ignoredDynamicTools,
  };
}
