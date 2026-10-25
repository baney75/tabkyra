/**
 * A prompt the user pastes into their own agent (Claude Code, Codex, pi, OMP, OpenCode,
 * Cursor, ...). The agent installs the CLI, connects the MCP server and installs the skills.
 * Plain steps only: no piped installers, and nothing that asks for a key or password.
 */
export function agentSetupPrompt(version: string): string {
	return `Set up Tabkyra (https://github.com/baney75/tabkyra) so you can use my browser. The Tabkyra extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix.

1. Check that Node 20+ and git are installed: node -v && git --version
2. If the tabkyra command is not on PATH, install the CLI that matches the extension:
   mkdir -p ~/tabkyra-src && cd ~/tabkyra-src
   If ~/tabkyra-src/tabkyra already exists, cd into it and run git fetch --tags instead of cloning.
   git clone --depth 1 --branch v${version} https://github.com/baney75/tabkyra && cd tabkyra
   If the tag v${version} doesn't exist, clone the default branch instead and tell me you did.
   (cd cli && npm ci && npm run build && npm link)
   If npm link fails with a permissions error, use "node ~/tabkyra-src/tabkyra/cli/dist/index.js" wherever these steps say "tabkyra".
3. Run: tabkyra setup --yes
   It registers the browser connection and adds the MCP server to Claude Code and Codex.
4. Connect this harness if setup didn't:
   - Any MCP client: a stdio server named "tabkyra" that runs ~/.config/tabkyra/tabkyra with the argument "mcp". JSON configs need the full path, not ~.
   - pi has no MCP client: run tabkyra pi-extension instead.
5. Install the skills: tabkyra skill install
   If this harness reads AGENTS.md instead of skill folders: tabkyra skill print >> AGENTS.md
6. Run tabkyra doctor and fix anything it reports with the command it prints.
7. Restart or reload MCP servers if this harness needs it, then call the tabkyra status tool. Tell me whether it says connected.

Don't ask me for API keys or passwords. Tabkyra doesn't need them for this.`;
}
