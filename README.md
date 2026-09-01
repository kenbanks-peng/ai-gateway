# AI Gateway

AI Gateway is a local OpenAI-compatible gateway for a ChatGPT Plus or Pro Codex subscription. It uses the maintained Codex OAuth and streaming implementation from `@earendil-works/pi-ai`. It does not use an OpenAI Platform API key.

The gateway binds to `127.0.0.1:8787` by default. It provides:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /health`

## Install and sign in

Node.js 22.19 or newer is required.

```sh
npm install
npm run build
npm link
ai-gateway login
```

The login command stores OAuth data in `$XDG_STATE_HOME/ai-gateway/auth.json` with restricted permissions. If `XDG_STATE_HOME` is not set, it uses `~/.local/state`. Runtime files use `$XDG_RUNTIME_DIR/ai-gateway`. The gateway does not read Pi's credential file by default.

## Start the gateway

```sh
ai-gateway serve
```

The `serve` command starts the gateway as a background service and returns after it is ready. Use `ai-gateway stop` to stop it. Service logs are in `$XDG_STATE_HOME/ai-gateway/gateway.log` by default. Use `ai-gateway status`, `ai-gateway models`, or `ai-gateway logout` for account and model information.

## Connect Crush

Add an `openai-compat` provider to Crush. Use a placeholder key because Crush requires a provider key, but the gateway ignores it.

```sh
provider add ai-gateway \
  --type openai-compat \
  --base-url "http://127.0.0.1:8787/v1" \
  --api-key "local"

model add ai-gateway/gpt-5.4-mini \
  --name "GPT-5.4 mini (Codex subscription)" \
  --context-window 272000 \
  --default-max-tokens 128000 \
  --can-reason true
```

Run `ai-gateway models` to see the model catalog supplied by the installed Pi package.

## Security

The gateway does not log OAuth credentials or prompt bodies. Keep the default loopback host unless you also add a separate access-control layer.
