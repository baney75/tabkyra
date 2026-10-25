# Changelog

## [Unreleased]

### Changed

- Dependencies `@mariozechner/pi-ai`, `pi-agent-core`, `pi-web-ui` (0.60.0) and `mini-lit` (0.2.1) now come from npm. A fresh clone builds with `npm install`; no sibling checkouts of pi-mono or mini-lit.
- Compared with the previously pinned pi-mono commit (`ff1ea1232`, v0.60.0 plus 11 commits), the published 0.60.0 lacks: OpenRouter's nested `reasoning` request parameter, the `gpt-5.4-mini` entry for ChatGPT sign-in (the published model list instead has `gpt-5.4-nano` for GitHub Copilot; every other model entry is identical), Bedrock prompt caching for inference profiles and a Vertex placeholder-key fix. Bedrock and Vertex are hidden in Tabkyra. On OpenRouter, reasoning effort falls back to the plain `reasoning_effort` field.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
