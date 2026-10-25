/**
 * A prompt the user pastes into their own agent (Claude Code, Codex, pi, OMP, OpenCode,
 * Cursor, ...). The agent installs the CLI, connects the MCP server and installs the skills.
 * Plain steps only: no piped installers, and nothing that asks for a key or password.
 */
export function agentSetupPrompt(version: string): string {
	// Without the version the clone can't be pinned, so refuse rather than copy a broken prompt.
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	return `Set up Tabkyra (https://github.com/baney75/tabkyra) so you can use my browser. The Tabkyra extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix.

1. Check that Node 20+ and git are installed: node -v && git --version
2. Install the CLI that matches the extension. If tabkyra is on PATH and tabkyra doctor reports no problems with the CLI or the build, skip the rest of this step and go to step 3. Otherwise:
   - If ~/tabkyra-src/tabkyra exists: cd into it. If git status shows local changes, stop and ask me. Otherwise run git fetch --tags && git checkout v${version}.
   - If it doesn't exist: mkdir -p ~/tabkyra-src && cd ~/tabkyra-src && git clone --depth 1 --branch v${version} https://github.com/baney75/tabkyra && cd tabkyra
   - If the tag v${version} doesn't exist, use the default branch instead and tell me you did.
   - Then: (cd cli && npm ci && npm run build && npm link)
   If npm link fails with a permissions error, use "node ~/tabkyra-src/tabkyra/cli/dist/index.js" wherever these steps say "tabkyra".
3. Run: tabkyra setup --yes
   It registers the browser connection and adds the MCP server to Claude Code and Codex.
4. Connect this harness, even if Tabkyra already works in another one:
   - Any MCP client: a stdio server named "tabkyra" that runs ~/.config/tabkyra/tabkyra with the argument "mcp". JSON configs need the full path, not ~.
   - pi has no MCP client: run tabkyra pi-extension instead.
5. Install the skills: tabkyra skill install
   If this harness reads AGENTS.md instead of skill folders: cd back to the project you started in (not the Tabkyra clone), then run tabkyra skill print >> AGENTS.md
6. Run tabkyra doctor and fix anything it reports with the command it prints.
7. Restart or reload MCP servers if this harness needs it, then call the tabkyra status tool. Tell me whether it says connected.

Don't ask me for API keys or passwords. Tabkyra doesn't need them for this.`;
}
