# Toolbox Router

Toolbox Router is an early-stage local model gateway with an OpenAI-compatible HTTP interface. In bridge mode it connects to Toolbox MCP as a local stdio client, discovers an allowlisted tool surface, and forwards model conversations to a configured upstream. Restricted tools require approval; Gmail credential tools are blocked by the router's policy.

This checkout was imported from `E:\_2026-AI\Projects\quoder\toolbox-router`, including its Git history and existing uncommitted changes. Runtime and test data from `D:\Projects\ToolboxRouter` was verified and moved here. The original source checkout remains in place. Runtime directories and credentials are ignored by Git. The default data path is `D:\Projects\toolbox\toolbox-router`; an explicit `TOOLBOX_ROUTER_DATA_DIR` still overrides it.

## Development and verification

Node.js 22 or later is required to develop this source checkout. Install the locked dependencies with `npm ci`, then run:

```text
npm run check
npm test
npm run verify:mcp
```

The last command starts the sibling `../toolbox-mcp/dist/index.js` with a fresh, temporary MCP home, discovers tools and makes one read-only `system_stats` call. Build Toolbox MCP first if its `dist/index.js` is missing. The command does not connect to a model provider or print the returned system data.

## Qoder test setup

The `start-spike.cmd` launcher starts bridge mode on `127.0.0.1:18787`. Configure Qoder's OpenAI-compatible Chat Completions provider with base URL `http://127.0.0.1:18787/v1`, model `toolbox-spike`, and the Router API key. For the local preview only, the default Router key is `toolbox-spike-key`; set `TOOLBOX_ROUTER_API_KEY` and use the same value in Qoder to replace it. It is separate from the AstrLink upstream key. AstrLink defaults to `http://127.0.0.1:7770/v1`; the upstream key can be provided in `TOOLBOX_ROUTER_UPSTREAM_API_KEY` or read from the existing Qoder `local-chat` provider. The launcher does not print either key or send model requests on startup. Pass `--smoke` only when you explicitly want live model checks.

The default listener is local-only. A non-loopback `TOOLBOX_ROUTER_HOST` requires an explicit non-default Router key of at least 16 characters. This preview uses plain HTTP; use a trusted connection for any LAN exposure. Toolbox Desktop's **Toolbox connections** tool checks the default local ports and Router/MCP readiness without accessing AstrLink's private data.

`scripts/build-portable.ps1` builds a test folder containing Node, Router, Toolbox MCP and their dependencies; its **Start Router.cmd** uses the included runtime. It requires the existing D: drive data-path convention and a configured upstream. `scripts/verify-portable.mjs` checks the bundled Router and MCP with a synthetic credential, without making an upstream model request.

For an explicit live check, `node scripts/verify-portable.mjs --live` uses the configured AstrLink credential and sends a synthetic prompt plus the isolated MCP profile's `crypto_status` result to the configured model provider. It starts a temporary Router on a separate local port and shuts it down afterward. The Qoder IDE and Qoder CLI can have separate login state; a CLI login failure does not establish whether the IDE can use its configured provider.

## Integration and release work

- The bridge uses MCP stdio directly; Marketplace remote endpoints retain their existing public-HTTPS policy. No remote-policy exception is needed for this local connection.
- Replace the fixed local preview key with a user-managed secret before a user-facing release; review LAN transport and credentials separately.
- Exercise the full client → Router → model provider → Toolbox MCP tool → client flow with a user-selected provider, including streaming, cancellation, failed upstream requests, and approval-required tools.
- Reconcile model aliases and tool policy with the current Toolbox MCP catalog; document which tools are available and how approvals are handled.
- Package the runtime and dependencies for end users, with configuration, data migration, startup/shutdown, and upgrade tests. The source checkout's Node.js and `npm ci` requirements are not a finished portable distribution.
- Test the packaged Router and Toolbox MCP together without relying on a separately installed Node.js runtime or development checkout.
