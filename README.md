# dk-vscode-llm-cache

VSCode extension that boots a local
[mosquitodog-vscode](https://github.com/doytsujin/dk-mosquitodog) cache
and routes Claude Code (and any tool that respects
`ANTHROPIC_BASE_URL`) through it for cross-session semantic caching.

Phase 3 of the [semantic proxy cache
design](https://github.com/doytsujin/dk-ecosystem/blob/main/revisions/v0.1.0/src/research/semantic-proxy-cache.md).

## What it does

**Tier 1**: terminal-side routing.
1. Spawns the `mosquitodog-vscode` binary as a child process bound to
   `127.0.0.1:<port>`.
2. Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` for every
   integrated terminal opened from this VSCode window — Claude Code in
   the terminal routes through the cache transparently.
3. Surfaces health, restart, and output commands.

**Tier 2**: VSCode LM API integration.
Registers as a `vscode.lm.LanguageModelChatProvider` (vendor
`mosquitodog-cache`) so Copilot Chat — and any extension calling
`vscode.lm.selectChatModels` — can pick the cached model from the
chat UI. Provider hits the gateway's OpenAI frontend
(`/v1/chat/completions` with `stream=true`), parses the SSE chunks,
and forwards them to VSCode's `progress.report()` API for streaming
display.

The provider advertises **two models** by default:
- `<family> (cached)` — normal: cache hit if available, else upstream.
- `<family> (no cache)` — bypass: skip both exact + semantic cache
  for the turn. One-click escape from a wrong-cache hit. Hide via
  `mosquitodogLlmCache.exposeBypassModel: false` if you want a
  single entry in the model picker.

Requires VSCode 1.95+ (where `registerLanguageModelChatProvider` is
in the stable API). Tool calling and image input are flagged as
unsupported in `capabilities` — Phase 9b's frontends drop both to
text today.

## Setup

1. Build and install the gateway binary from the
   [mosquitodog](https://github.com/doytsujin/dk-mosquitodog) workspace:
   ```sh
   cargo build --release -p mosquitodog-target-vscode
   sudo install target/release/mosquitodog-vscode /usr/local/bin/
   ```
2. Build this extension:
   ```sh
   npm install
   npm run build
   ```
3. Package and install:
   ```sh
   npm run package           # produces a .vsix
   code --install-extension dk-vscode-llm-cache-0.1.0.vsix
   ```
4. Set `mosquitodogLlmCache.anthropicApiKey` in VSCode settings, or
   export `ANTHROPIC_API_KEY` before launching VSCode.
5. Reload VSCode. Open a terminal:
   ```sh
   echo $ANTHROPIC_BASE_URL    # http://127.0.0.1:8765
   ```
   Claude Code launched from this terminal now routes through the cache.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `mosquitodogLlmCache.binaryPath` | `mosquitodog-vscode` | bare name (PATH) or absolute |
| `mosquitodogLlmCache.port` | `8765` | loopback only |
| `mosquitodogLlmCache.anthropicApiKey` | `""` | falls back to env var |
| `mosquitodogLlmCache.anthropicModel` | `claude-sonnet-4-6` | passed as `ANTHROPIC_MODEL` |
| `mosquitodogLlmCache.exportBaseUrl` | `true` | set `ANTHROPIC_BASE_URL` in terminals |
| `mosquitodogLlmCache.exposeBypassModel` | `true` | advertise `<family> (no cache)` variant in chat model picker |
| `mosquitodogLlmCache.includeFileContext` | `true` | send open-editor fingerprint with each chat request so file edits bust the cache |

## Commands

- `Mosquitodog: Check Cache Health` — GET `/health` against the gateway
- `Mosquitodog: Restart Cache` — SIGTERM + respawn
- `Mosquitodog: Show Cache Output` — opens the gateway's stdout/stderr channel

## Status

- Tier 1 wired and tested via the binary smoke test.
- Tier 2 (Chat Model Provider for Copilot Chat) wired against
  `@types/vscode` 1.120 stable API (`registerLanguageModelChatProvider`).
  Requires VSCode 1.95+. Smoke-tested via `tsc` strict typecheck +
  esbuild bundle; live behaviour verification needs a real VSCode
  session.
- Cross-session memory layer landed in Phase 4 of the parent design;
  real SQLite persistence in Phase 7a; Semantic Link envelope in 7b.
