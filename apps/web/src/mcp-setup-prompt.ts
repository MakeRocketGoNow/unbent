/**
 * The text "Copy setup prompt" puts on the clipboard: instructions for a coding agent
 * (Claude Code, Codex, Cursor and the rest) to register this instance's MCP server
 * itself.
 *
 * A URL alone leaves the person to find where their agent keeps its MCP config, which is
 * a different file and a different key for every agent (`url`, `serverUrl`, a `type`
 * beside it or not). The agent already knows which one it is and can edit its own
 * config, so the prompt carries every agent's recipe and lets it pick. The shape follows
 * the prompts other MCP services hand out for the same job.
 *
 * Built from the instance's own URL, never unbent.app's, for the reason `McpUrl` gives:
 * a self-hosted instance's prompt must not connect the agent to someone else's server.
 * The server is registered as `unbent` either way, since that is the name the agent's
 * tool list shows and a person has one instance at a time.
 *
 * Nothing here asks for a token: the server authenticates with OAuth in the browser, and
 * an agent told only "connect to this server" has been known to go looking for an API key
 * to paste. The prompt says so outright.
 */
export function mcpSetupPrompt(url: string): string {
  const json = (value: unknown) => JSON.stringify(value);
  return `These are instructions from Unbent for connecting your AI agent to the user's Unbent notes through Unbent's MCP server.

Complete all of the following steps yourself by running the commands or editing the config files directly. Do not ask the user to run any of these commands.

Register the Unbent MCP server at ${url} using the section for your agent below. The server authenticates with OAuth in the browser, so do not ask for or store an API token.

## Claude Code

\`\`\`
claude mcp add --transport http --scope user unbent ${url}
\`\`\`

Then tell the user to restart Claude Code, run \`/mcp\`, and select unbent to sign in.

## Codex

\`\`\`
codex mcp add unbent --url ${url}
codex mcp login unbent
\`\`\`

## OpenCode: \`~/.config/opencode/opencode.json\`

Add under \`"mcp"\`:

\`\`\`json
"unbent": ${json({ type: 'remote', url, enabled: true, oauth: {} })}
\`\`\`

Then run:

\`\`\`
opencode mcp auth unbent
\`\`\`

## Devin Desktop (formerly Windsurf)

\`\`\`
devin mcp add -s user unbent ${url}
\`\`\`

Or add to \`~/.config/devin/mcp_config.json\` under \`"mcpServers"\`:

\`\`\`json
"unbent": ${json({ url })}
\`\`\`

Older Windsurf installs use \`~/.codeium/windsurf/mcp_config.json\` instead. Add under \`"mcpServers"\` (note: \`serverUrl\`, not \`url\`):

\`\`\`json
"unbent": ${json({ serverUrl: url })}
\`\`\`

Sign-in opens in the browser the first time an Unbent tool is used.

## GitHub Copilot (VS Code)

Add to \`~/.copilot/mcp-config.json\` (or \`$COPILOT_HOME/mcp-config.json\` when \`COPILOT_HOME\` is set) under \`"mcpServers"\`:

\`\`\`json
"unbent": ${json({ type: 'http', url })}
\`\`\`

Or register it in the VS Code user profile:

\`\`\`
code --add-mcp '${json({ name: 'unbent', type: 'http', url })}'
\`\`\`

Sign-in opens in the browser the first time an Unbent tool is used.

## Cursor and all other agents

Add to \`~/.cursor/mcp.json\` (Cursor) or your agent's MCP config file under \`"mcpServers"\`:

\`\`\`json
"unbent": ${json({ url })}
\`\`\`

Sign-in opens in the browser the first time an Unbent tool is used.

## Claude.ai, the Claude apps and ChatGPT

These add servers in their own settings, not from a config file, so you cannot do it for the user. Tell them to add a custom connector (in Claude: Settings, then Connectors, then Add custom connector) with the URL ${url}, and to approve access in the browser window that opens.

Once done, tell the user:

\`\`\`
┌─ Unbent MCP Setup Complete ────────────────────────────┐
│  ✓ MCP  <path>                                         │
│                                                        │
│  ⚡ Restart your agent to load the Unbent MCP server   │
└────────────────────────────────────────────────────────┘
\`\`\`

Once connected, the user can see and disconnect the agent at ${new URL('/settings/connected-apps', url).href}
`;
}
