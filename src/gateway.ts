import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';

export interface GatewayConfig {
    binaryPath: string;
    port: number;
    env: Record<string, string>;
}

/**
 * Owns the mosquitodog-vscode child process. start() blocks until the
 * gateway responds on /health (or times out). stop() SIGTERMs and
 * SIGKILLs after a short grace window. Output is mirrored into a
 * dedicated VSCode output channel so the user can inspect it via
 * the "Mosquitodog: Show Cache Output" command.
 */
export class GatewayProcess {
    private process: ChildProcess | undefined;
    private readonly output: vscode.OutputChannel;

    constructor(private readonly config: GatewayConfig) {
        this.output = vscode.window.createOutputChannel('Mosquitodog Cache');
    }

    showOutput(): void {
        this.output.show(true);
    }

    async start(): Promise<void> {
        if (this.process) {
            return;
        }

        const env = {
            ...process.env,
            ...this.config.env,
            BIND_ADDR: `127.0.0.1:${this.config.port}`,
        };

        this.output.appendLine(
            `[spawn] ${this.config.binaryPath} (BIND_ADDR=${env.BIND_ADDR})`,
        );

        const child = spawn(this.config.binaryPath, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.process = child;

        child.stdout?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => this.output.append(chunk.toString()));

        child.on('exit', (code, signal) => {
            this.output.appendLine(`[exit code=${code} signal=${signal}]`);
            if (this.process === child) {
                this.process = undefined;
            }
        });

        child.on('error', (err) => {
            this.output.appendLine(`[spawn error] ${err.message}`);
        });

        await this.waitForReady(10_000);
    }

    async stop(): Promise<void> {
        const child = this.process;
        if (!child) {
            return;
        }
        this.process = undefined;
        child.kill('SIGTERM');
        await delay(500);
        if (!child.killed) {
            child.kill('SIGKILL');
        }
    }

    async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    private async waitForReady(timeoutMs: number): Promise<void> {
        const start = Date.now();
        const url = `http://127.0.0.1:${this.config.port}/health`;
        let lastError: unknown;
        while (Date.now() - start < timeoutMs) {
            if (!this.process) {
                throw new Error('gateway process exited before becoming ready');
            }
            try {
                const response = await fetch(url);
                if (response.ok) {
                    this.output.appendLine(`[ready] /health 200`);
                    return;
                }
                lastError = new Error(`/health ${response.status}`);
            } catch (err) {
                lastError = err;
            }
            await delay(200);
        }
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`gateway did not become ready within ${timeoutMs}ms (${detail})`);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
