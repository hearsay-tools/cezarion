# CI adapter wire evidence (2026-09-22)

`core/ci-tools.test.ts` H1 runs every real runner against its offline wire, on
fresh and resumed sessions. The mock consumes exactly that runner's injected
configuration, negotiates with the bundled SDK MCP adapter, lists tools, calls
`cezar_wait_for_ci`, and reaches the real private IPC controller. Pi loads the
actual extension and invokes its registered tool. No GitHub request or model
turn is needed. Tokens are absent from descriptor snapshots; Cursor's required
ACP environment values are redacted when the mock records wire input.

Installed interfaces checked for these fixtures:

| Backend | Version | Evidence |
| --- | --- | --- |
| Claude | 2.1.278 | Installed `--help` supports repeated/JSON `--mcp-config` and separate `--strict-mcp-config`. Only the former is used. Config env references expand before stdio launch; the generated tool is appended to restricted `--allowedTools`. |
| Codex | 0.155.1 | Installed `app-server generate-json-schema` declares arbitrary `config` for `thread/start` and `thread/resume`. A real isolated app-server probe performed `mcpServerStatus/list` and `mcpServer/tool/call` successfully on both start and resume, using injected offline history to create a resumable rollout, then unsubscribing and injecting a new server name on resume, no provider turn. Dotted `mcp_servers.<unique-name>` overrides preserve unrelated servers and delegation config. |
| OpenCode | 1.18.32 | Local MCP config uses `type: local`, command arrays, inherited process env. `OPENCODE_CONFIG_CONTENT` has runtime precedence; only one server is merged, existing runtime settings and config-file discovery remain intact. Malformed supplied runtime JSON fails explicitly. |
| Cursor | 2026.09.18-9a7762b | Installed `1699.index.js` passes `e.mcpServers` through both ACP new/load into session resources. The session loader starts with existing `mcpLease.getClients`, adds session entries, and retains team-settings/disabled-server middleware. Stdio descriptors accept `{name,command,args,env:[{name,value}]}`. Installed `index.js` SDK's default env includes only HOME/LOGNAME/PATH/SHELL/TERM/USER; therefore exactly CEZ_TOOL_TOKEN/SOCKET must be supplied in the ACP environment. |
| Pi | 0.87.0 | Installed extension `types.d.ts`/`loader.js` expose `registerTool` with parameters; pi-ai validation explicitly supports plain JSON Schema. Repeated explicit `--extension` preserves discovery and the retry extension. Selected tools retain the CI tool. |

Primary documentation consulted:

- <https://code.claude.com/docs/en/mcp> (config merging and environment expansion)
- <https://developers.openai.com/codex/mcp> (`env_vars` forwarding)
- <https://opencode.ai/docs/mcp-servers/> and <https://opencode.ai/docs/config/>
- <https://cursor.com/docs/cli/acp>

The private route inventory is **GET and POST `/api/v1/tools/ci-wait`** over a
process-owned Unix socket / Windows named pipe only. GET holds the adapter's
owner-lifetime connection; POST uses shared request-validation middleware and
contract request/receipt/error shapes. It is not mounted on the cockpit app.
`CiToolApp` exposes the chained Hono type. SIGKILL of the owning controller is
covered by `controller.test.ts`; it closes the MCP adapter without model work.
Normal close revokes capabilities, destroys owned IPC connections and removes
the private directory. Hard death may leave an inert socket pathname, never a
reusable credential or listener.

`test/e2e/package-cli.test.ts` packs and installs the artifact into an isolated
consumer and invokes both MCP and Pi adapters with no source tree or private
workspace packages. `@modelcontextprotocol/sdk` 1.30.0 owns MCP negotiation and
framing; the adapter exposes only the shared-contract CI tool.
