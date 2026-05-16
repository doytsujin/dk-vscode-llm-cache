import * as vscode from 'vscode';

/**
 * Phase 3 Tier-2: registers the local mosquitodog-vscode gateway as a
 * `vscode.lm.LanguageModelChatProvider`, so Copilot Chat (and any
 * extension consuming `vscode.lm.selectChatModels`) can route through
 * the cache.
 *
 * Calls the gateway via its OpenAI frontend (POST /v1/chat/completions
 * with stream=true). The OpenAI SSE shape is the simplest to parse in
 * TypeScript — `data: {chunk}\n\n` per delta with a `data: [DONE]`
 * sentinel — and the cache pipeline is identical regardless of which
 * frontend the client uses, so model identity is just metadata.
 */

interface ProviderConfig {
    port: number;
    /** Family + display name used to advertise the model in the chat UI. */
    family: string;
    /**
     * If true, advertise a second model variant `<family> (no cache)`
     * that bypasses the cache for every request (sets
     * `cache.mode = "bypass"`). Lets users escape a wrong-cache hit
     * without leaving the chat UI: pick the bypass model from the
     * Copilot Chat dropdown for the next turn.
     */
    exposeBypassModel: boolean;
    /**
     * If true, attach a per-request fingerprint of open editor files
     * via `_mosquitodog.file_context`. The gateway folds this into
     * the cache key, so editing a referenced file busts the cache
     * automatically. Uses `document.version` (per-session monotonic
     * counter) — sufficient for in-session invalidation, doesn't
     * catch edits made while VSCode was closed.
     */
    includeFileContext: boolean;
}

const BYPASS_SUFFIX = '-bypass';

export class MosquitodogChatProvider
    implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
    constructor(private readonly config: ProviderConfig) {}

    /**
     * Advertise the gateway-backed model. When `exposeBypassModel` is
     * enabled, also advertises a `<family> (no cache)` variant whose
     * id ends in `-bypass`; `provideLanguageModelChatResponse`
     * detects the suffix and forces `cache.mode = "bypass"` for those
     * calls, so users have a one-click escape from wrong-cache hits
     * without restarting the gateway or toggling a global setting.
     */
    async provideLanguageModelChatInformation(
        _options: vscode.PrepareLanguageModelChatModelOptions,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const baseId = `mosquitodog-cache-${this.config.family}`;
        const cached: vscode.LanguageModelChatInformation = {
            id: baseId,
            name: `${this.config.family} (cached)`,
            family: this.config.family,
            tooltip:
                'Routed through the local mosquitodog cache — semantic + memory-aware. ' +
                'See Mosquitodog: Show Cache Output for details.',
            version: '1',
            maxInputTokens: 200_000,
            maxOutputTokens: 8_192,
            capabilities: {
                // Tool / image input flow through the cache only as
                // text today (Phase 9b's frontends drop them); flag
                // honestly so chat hosts don't try to use them.
                imageInput: false,
                toolCalling: false,
            },
        };
        if (!this.config.exposeBypassModel) {
            return [cached];
        }
        const bypass: vscode.LanguageModelChatInformation = {
            id: `${baseId}${BYPASS_SUFFIX}`,
            name: `${this.config.family} (no cache)`,
            family: this.config.family,
            tooltip:
                'Same upstream model, but skips both the exact + semantic cache for this turn. ' +
                'Pick this if a previous response looked stale or wrong.',
            version: '1',
            maxInputTokens: 200_000,
            maxOutputTokens: 8_192,
            capabilities: {
                imageInput: false,
                toolCalling: false,
            },
        };
        return [cached, bypass];
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const openAiMessages = messages.map((m) => ({
            role: roleString(m.role),
            content: messageText(m),
        }));

        const bypassCache = model.id.endsWith(BYPASS_SUFFIX);
        const fileContext = this.config.includeFileContext
            ? collectFileContext()
            : [];

        const mosquitodogExt: Record<string, unknown> = {};
        if (bypassCache) {
            // mosquitodog ext: skip both exact + semantic cache for this
            // turn. The frontend's translate_request honours this and
            // sets ChatRequest.cache_options.mode = "bypass".
            mosquitodogExt.cache = { mode: 'bypass' };
        }
        if (fileContext.length > 0) {
            // Phase 1.5: gateway folds these (path, fingerprint) pairs
            // into the cache key — same prompt + edited file → cache
            // miss → fresh upstream call.
            mosquitodogExt.file_context = fileContext;
        }

        const body: Record<string, unknown> = {
            model: model.family,
            messages: openAiMessages,
            stream: true,
        };
        if (Object.keys(mosquitodogExt).length > 0) {
            body._mosquitodog = mosquitodogExt;
        }

        const url = `http://127.0.0.1:${this.config.port}/v1/chat/completions`;
        const controller = new AbortController();
        const cancelSub = token.onCancellationRequested(() => controller.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok || !response.body) {
                throw new Error(`gateway returned ${response.status}`);
            }

            // Parse OpenAI-style SSE: split on \n\n boundaries, look at
            // each event's `data: ...` line. `data: [DONE]` is the
            // terminal sentinel.
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    const event = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');

                    const dataLine = event
                        .split('\n')
                        .find((line) => line.startsWith('data:'));
                    if (!dataLine) {
                        continue;
                    }
                    const payload = dataLine.replace(/^data:\s?/, '').trim();
                    if (payload === '[DONE]' || payload === '') {
                        return;
                    }
                    try {
                        const chunk = JSON.parse(payload);
                        const delta: string | undefined =
                            chunk?.choices?.[0]?.delta?.content;
                        if (typeof delta === 'string' && delta.length > 0) {
                            progress.report(new vscode.LanguageModelTextPart(delta));
                        }
                        const finish: string | undefined =
                            chunk?.choices?.[0]?.finish_reason;
                        if (typeof finish === 'string' && finish.length > 0) {
                            return;
                        }
                    } catch {
                        // Malformed line — skip; keep reading.
                    }
                }
            }
        } finally {
            cancelSub.dispose();
        }
    }

    /**
     * Rough token estimate. The gateway doesn't expose a tokenizer
     * endpoint, so we approximate at 4 chars per token — close enough
     * for budget warnings, intentionally not authoritative. Real
     * counts arrive in the upstream's response usage block (which the
     * caller can fetch via /v1/artifacts using the trace_id).
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken,
    ): Promise<number> {
        const str =
            typeof text === 'string'
                ? text
                : (text.content as ReadonlyArray<unknown>)
                      .map((p) =>
                          p instanceof vscode.LanguageModelTextPart
                              ? p.value
                              : '',
                      )
                      .join('');
        return Math.max(1, Math.ceil(str.length / 4));
    }
}

function roleString(role: vscode.LanguageModelChatMessageRole): string {
    if (role === vscode.LanguageModelChatMessageRole.User) {
        return 'user';
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
        return 'assistant';
    }
    // VSCode's role enum has only User + Assistant; system messages
    // are typically expressed as a User message with a label. Default
    // unknown roles to user.
    return 'user';
}

function messageText(m: vscode.LanguageModelChatRequestMessage): string {
    return m.content
        .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
        .join('');
}

/**
 * Collect a per-request file fingerprint from currently open editor
 * documents. Schema matches `mosquitodog_server::FileContext`:
 * `[{path, fingerprint}]`. Skips untitled buffers and non-file URIs
 * (e.g. settings, output channels).
 *
 * Fingerprint is `v<document.version>` — a per-session monotonic
 * counter that increments on every edit. Cheap (no fs.statSync per
 * file), correct for in-session invalidation. Cross-session edits
 * (file changed while VSCode was closed) are not caught — would need
 * an mtime/content-hash signal, parked for a follow-up.
 */
function collectFileContext(): Array<{ path: string; fingerprint: string }> {
    const out: Array<{ path: string; fingerprint: string }> = [];
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== 'file' || doc.isUntitled) {
            continue;
        }
        out.push({
            path: doc.uri.fsPath,
            fingerprint: `v${doc.version}`,
        });
    }
    return out;
}
