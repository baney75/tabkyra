# Sign-in policy

Tabkyra takes **API keys only**. It has no subscription sign-in for any provider.

Every subscription sign-in this fork inherited from Sitegeist worked by posing as
another product: it sent Codex CLI's, VS Code Copilot Chat's or Gemini CLI's OAuth
client id, and copied their headers. A provider can't tell that traffic from abuse of
its own app, and its terms let it suspend the account. A browser extension
must not put its users' accounts at risk to save them an API key, so those flows are gone.

The rule for adding any sign-in back: keep a flow only when the provider explicitly
permits it for third-party apps, through a client registered to Tabkyra. Never send
another app's client id, `originator`, user agent or headers.

Checked 2026-10-25 against the providers' own pages.

| Provider | Flow | Allowed for Tabkyra? | Source (checked 2026-10-25) | What Tabkyra does |
| --- | --- | --- | --- | --- |
| OpenAI | ChatGPT Plus/Pro sign-in with Codex CLI's OAuth client (`auth.openai.com`, `originator`, `codex_cli_simplified_flow`) against `chatgpt.com/backend-api/codex` | **No.** The Codex auth docs describe that sign-in for Codex itself and don't extend it to other apps. OpenAI's sanctioned route for other apps is Sign in with ChatGPT (SIWC), where each app gets its own client id at registration. | [Codex auth](https://developers.openai.com/codex/auth); [SIWC: ChatGPT plan usage for open-source and locally hosted apps](https://developers.openai.com/siwc/token-sharing-open-source) | Removed. OpenAI API key only. SIWC is the path to add later (see below). |
| OpenAI | API key (`api.openai.com`) | Yes | [API keys](https://platform.openai.com/docs/api-reference/authentication) | Kept. Billed by OpenAI. |
| GitHub | Copilot device flow with VS Code Copilot Chat's client id, `Editor-Version: vscode/...`, `Copilot-Integration-Id: vscode-chat`, `User-Agent: GitHubCopilotChat/...`, and the undocumented `copilot_internal/v2/token` | **No.** GitHub documents no third-party use of that client or endpoint. The sanctioned route is the Copilot SDK with the app's own registered GitHub OAuth App. | [Authenticate the Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk); [Terms for Additional Products](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) | Removed. No replacement yet: it needs a Tabkyra OAuth App. GitHub Models (PAT) was retired on 2026-07-30 ([changelog](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/)). |
| Google | Gemini CLI's OAuth client id and secret against Code Assist (`cloudcode-pa.googleapis.com`) | **No, explicitly.** "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software ... is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account." | [Gemini CLI terms and privacy](https://geminicli.com/docs/resources/tos-privacy/) (updated 2026-04-10); [Gemini CLI FAQ](https://geminicli.com/docs/resources/faq/) | Removed, along with Antigravity, which works the same way. |
| Google | Gemini API key from Google AI Studio | Yes. The FAQ names it as the supported method. | [Gemini API key](https://ai.google.dev/gemini-api/docs/api-key); [pricing](https://ai.google.dev/gemini-api/docs/pricing) | Kept. Free tier with limits, paid above it, billed by Google. |
| Anthropic | Claude Pro/Max sign-in (claude.ai OAuth, `sk-ant-oat` tokens) | **No, explicitly.** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) | Removed earlier. An `sk-ant-oat` token pasted into the key field is refused. |
| Anthropic | API key from the Claude Console | Yes | same page: "should use API key authentication through Claude Console" | Kept. Billed by Anthropic. |
| Others (OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face, z.ai, MiniMax, custom and local providers) | API key or none | Yes | each provider's API docs | Kept. Billed by the provider (local models aren't billed). |

## What the code does

- `src/auth/policy.ts` lists the removed providers and the subscription-only APIs
  (`openai-codex-responses`, `google-gemini-cli`). `resolveApiKey` refuses stored OAuth
  credentials and Claude subscription tokens. The stream function refuses any model on a
  removed provider or API, so a model saved before the update can't run.
- On startup, before any chat is restored, the side panel deletes tokens left by the
  removed sign-ins and says so once. A saved chat on a removed provider reopens on a
  working model.
- `scripts/build.mjs` strips pi-ai's Codex, Gemini CLI and Copilot provider code, their
  model entries, and the Claude Code identity (user agent, `x-app`, beta flag, system
  prompt) from the bundle. If upstream moves any of those files, the build fails.
- The CORS rules for `auth.openai.com`, `github.com/login` and `platform.claude.com` are
  gone, as are model discovery for ChatGPT and Copilot.
- The Settings tab is "API Keys". The tab, the first-run dialog and the key prompt say
  that the provider bills API use.
- The CLI and the MCP server have no sign-in at all. They drive the browser and never
  call a model.
- `test/auth-policy.test.mjs` (run by `./check.sh`) fails if any of the removed client
  ids (plain or base64), `originator`, `codex_cli_simplified_flow`, the Copilot or Gemini
  CLI headers, `copilot_internal`, `cloudcode-pa` or the removed OAuth hosts come back
  in `src/`, `static/`, `cli/src/` or `scripts/`, or in a fresh build of the extension
  (it builds a throwaway copy), or if a removed provider gets a sign-in again. Header
  names match case-insensitively.

## Adding a sanctioned sign-in later

- **OpenAI, Sign in with ChatGPT.** OpenAI runs SIWC for open-source and locally hosted
  apps: the app registers during sign-in and receives its own client id, bound to the
  user and workspace, and calls the Responses API. The registration and endpoint details
  are on the SIWC "Registration and sign-in" page. Adding it needs a real sign-in to test,
  so it was left out of this change. A paid or hosted build needs OpenAI's interest form.
- **GitHub Copilot.** Register a Tabkyra GitHub OAuth App under Donovan's account and
  follow the Copilot SDK docs.
- **Google.** No subscription route exists for third-party apps. Keep API keys.
- **Anthropic.** No subscription route exists for third-party apps. Keep API keys.
