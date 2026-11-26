# Qoder integration: clean reboot check

After reboot, before starting the suite, check that local ports 7770 (AstrLink)
and 18787 (Router) are free. If either is occupied, identify the existing
service before starting another instance.

1. Start AstrLink and confirm its local gateway is reachable on port 7770.
2. Start `dist/portable-preview/Start Router.cmd` and leave it running. It starts
   its bundled Toolbox MCP in bridge mode on `127.0.0.1:18787`.
3. Open Toolbox Desktop → **Toolbox connections** → **Check local setup**.
   Confirm the gateway port is reachable and Router reports a ready MCP bridge.
4. Open Qoder's existing Toolbox Router provider. Its base URL is
   `http://127.0.0.1:18787/v1` and the model is `toolbox-spike`. Send a short
   non-sensitive prompt, then ask for a safe read-only Toolbox tool.
5. Verify a normal response, a tool result, and a clear error when AstrLink is
   unavailable. Restart the stopped service and confirm recovery. Record what
   passed and any error details without recording API keys or personal data.

The Router preview's default local key is for testing. Replace it with a
user-managed key before broader use. A listening AstrLink port alone does not
prove that its model provider is authenticated.
