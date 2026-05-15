import * as vscode from 'vscode';
import { GatewayProcess } from './gateway';

let gateway: GatewayProcess | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration('mosquitodogLlmCache');
    const binaryPath = config.get<string>('binaryPath') ?? 'mosquitodog-vscode';
    const port = config.get<number>('port') ?? 8765;
    const anthropicModel = config.get<string>('anthropicModel') ?? 'claude-sonnet-4-6';
    const exportBaseUrl = config.get<boolean>('exportBaseUrl') ?? true;
    const settingsKey = config.get<string>('anthropicApiKey') ?? '';
    const anthropicApiKey = settingsKey || process.env.ANTHROPIC_API_KEY || '';

    if (!anthropicApiKey) {
        vscode.window.showWarningMessage(
            'Mosquitodog LLM Cache: set mosquitodogLlmCache.anthropicApiKey or ' +
            'export ANTHROPIC_API_KEY before launching VSCode to enable the cache.',
        );
        return;
    }

    gateway = new GatewayProcess({
        binaryPath,
        port,
        env: {
            ANTHROPIC_API_KEY: anthropicApiKey,
            ANTHROPIC_MODEL: anthropicModel,
        },
    });

    try {
        await gateway.start();
        vscode.window.setStatusBarMessage(`$(check) Mosquitodog cache @ :${port}`, 5_000);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
            `Failed to start mosquitodog-vscode (${binaryPath}): ${msg}. ` +
            `Run "Mosquitodog: Show Cache Output" for details.`,
        );
        gateway.showOutput();
        return;
    }

    if (exportBaseUrl) {
        // Surfaced to every integrated terminal opened from this window so
        // Claude Code (and anything else honouring the var) routes through
        // the local cache. Cleared automatically when the extension is
        // disabled or VSCode quits.
        context.environmentVariableCollection.replace(
            'ANTHROPIC_BASE_URL',
            `http://127.0.0.1:${port}`,
        );
        context.environmentVariableCollection.description =
            `Mosquitodog cache @ http://127.0.0.1:${port}`;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('mosquitodogLlmCache.health', async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${port}/health`);
                const body = await response.text();
                vscode.window.showInformationMessage(`Mosquitodog ${response.status}: ${body}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Health check failed: ${msg}`);
            }
        }),
        vscode.commands.registerCommand('mosquitodogLlmCache.restart', async () => {
            await gateway?.restart();
            vscode.window.showInformationMessage('Mosquitodog cache restarted');
        }),
        vscode.commands.registerCommand('mosquitodogLlmCache.showOutput', () => {
            gateway?.showOutput();
        }),
    );

    // Tier 2 — register as a Language Model Chat Provider so Copilot Chat
    // and other consumers of `vscode.lm.*` can route through the cache.
    // The proposed API shape (`registerChatModelProvider` / `LanguageModelChatProvider`)
    // is still settling across VSCode versions; wiring it requires
    // `enableProposedApi` in package.json and a per-target VSCode build.
    // Tracked separately so this Tier-1 build remains stable on stock VSCode.
    // TODO(phase-3-tier-2): land Chat Model Provider once the API
    // stabilises in the user's target VSCode version.
}

export async function deactivate(): Promise<void> {
    await gateway?.stop();
    gateway = undefined;
}
