# Sign in with ChatGPT

OMP supports OpenAI's Sign in with ChatGPT flow as the separate `openai-chatgpt` provider. It uses a registration created for this OMP installation, local credential storage, and the public OpenAI Responses API.

| Provider | Authentication | Model catalog |
| --- | --- | --- |
| `openai-chatgpt` | Sign in with ChatGPT; authorize ChatGPT plan usage | Models returned for each local registration |
| `openai` | Your existing OpenAI API key | Existing API model discovery and configuration |
| `openai-codex` | Existing Codex login | Existing Codex integration |

The providers can coexist. Adding a ChatGPT login does not change your selected model, role settings, or existing API credentials.

## Log in

Run:

```sh
omp login openai-chatgpt
```

Inside an OMP session, use `/login` and choose **OpenAI (Sign in with ChatGPT)**. Follow the browser authorization flow. The first login creates a registration for this installation. Future logins let you reconnect an existing registration or add another one. Two registrations with the same email remain separate; the picker includes a registration identifier to distinguish them.

OpenAI determines whether the account is eligible and which scopes it grants. If the sign-in succeeds without authorization to use the ChatGPT plan, OMP keeps the signed-in identity and displays that plan usage is disabled. Use `/login` again and choose **Enable plan usage** for that registration to request consent. This state does not provide an inference credential or populate an API-key model catalog.

The terminal shows a local browser-launch link. Authorization URLs containing identity tokens stay inside the local callback flow. If a callback must be pasted manually, use the complete callback URL from the browser so OMP can validate the state and issued client identifier.

## Select models and use a reviewer

After authorization, OMP discovers the models available to that registration. Use the existing `/model` or `/switch` flow and select a provider-qualified model:

```text
openai-chatgpt/<model slug shown by OMP>
```

Use the actual discovered slug. OMP does not substitute the API or Codex model catalog when ChatGPT discovery has no model to offer.

Existing model roles, agent frontmatter, task overrides, and account restrictions continue to apply. For example, the usual task configuration can assign only the reviewer to ChatGPT:

```yaml
task:
  agentModelOverrides:
    reviewer: "openai-chatgpt/<discovered model slug>"
```

Your main model and other agents can keep their current providers. Local OMP workers use the same credential service; no separate reviewer login is required. Account choices remain subject to the existing role and session rules, with each ChatGPT registration treated as a distinct account.

## Switch back to an API model

Select `openai/<model>` or another existing provider through the usual model selector or `/switch`. The API credential remains stored separately. Existing model fallback remains in effect according to your configuration, and each attempted model uses its own provider's credentials and request contract.

ChatGPT quota exhaustion does not automatically rotate through other ChatGPT registrations to obtain more quota. This does not disable configured model fallback or manual account/model selection.

## Usage and supported requests

OMP labels this provider as **ChatGPT plan** and links to [Manage usage](https://chatgpt.com/settings/usage). Token statistics continue to accumulate. OMP does not apply API token prices to ChatGPT plan usage: mixed sessions retain their known API cost subtotal and indicate that they also contain unpriced usage. Switching models or reopening a session preserves that indication.

Normal streamed conversation and local tool-call/result rounds use the shared Responses implementation. The ChatGPT route sends `store: false` and complete history over HTTP. WebSocket continuation remains limited to the same authenticated connection. Local function and custom tools are represented using the supported `additional_tools` form; this does not change how OMP executes tools.

OpenAI's ChatGPT route has a narrower request contract than the API-key route. OMP omits incompatible generated defaults and reports explicit incompatible options, such as an output-token cap, temperature, persistent response storage, or unsupported hosted tools. It also checks the final payload after custom overrides. These checks apply only to the ChatGPT request. The API-key provider keeps its existing behavior.

## Log out

Use `/logout`, choose the provider, then choose the registration. Identity-only sign-ins are included. OMP attempts to revoke the current refresh token, clears local secret material, and retains the non-secret registration mapping for a future reconnect. If remote revocation cannot be confirmed, the UI says so after clearing the local secrets.

Credential refresh and logout share the existing local ownership mechanism. A rotated token is saved before subsequent identity validation, so a failed key lookup does not cause OMP to reuse the replaced refresh token.

## Local storage and connection boundaries

This integration uses the local OMP credential database. It does not import credentials or registrations from another application. The host identifier must be persisted successfully; a temporary identifier is not used for registration.

The generic auth-broker credential-sharing API does not export these credentials, accept uploads of them, or serve refresh operations for them. The generic inference gateway does not proxy this provider to other applications. These boundaries do not affect OMP's own local worker authentication service. Ordinary network proxies continue to work; replacing the OAuth resource with a custom API endpoint does not.

## Development checks

The repository requires Bun and its normal native dependencies. After installing them, run the normal checks and the focused tests:

```sh
bun install --frozen-lockfile
bun run gen:compat
bun run check:ts
bun test packages/ai/test/registry/oauth/openai-chatgpt.test.ts packages/ai/test/auth-storage-chatgpt.test.ts
bun test packages/ai/test/openai-chatgpt-responses.test.ts
bun test packages/catalog/test/openai-chatgpt-discovery.test.ts
```

Also run the affected auth-broker, model-discovery, login/logout, session-usage, and status-line tests before merging. A real local-account check should cover initial consent, a tool round, a reviewer task, an API switch, reconnect, and logout. A development test double cannot establish account eligibility or confirm the live authorization server's behavior.

## Protocol references

- [OpenAI Sign in with ChatGPT](https://developers.openai.com/siwc/)
- [Open-source token sharing](https://developers.openai.com/siwc/token-sharing-open-source/)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
