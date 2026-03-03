import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let wranglerProcess: ChildProcess | null = null;

const WRANGLER_PORT = 8787;
const HEALTH_URL = `http://localhost:${WRANGLER_PORT}/health`;
const POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 30_000;

async function pollHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Wrangler dev did not become healthy within ${timeoutMs}ms`);
}

export async function setup(): Promise<() => Promise<void>> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cwd = resolve(__dirname, '..', '..', '..');

  wranglerProcess = spawn('pnpm', ['exec', 'wrangler', 'dev', '--port', String(WRANGLER_PORT)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  // Suppress wrangler stdout/stderr noise
  wranglerProcess.stdout?.resume();
  wranglerProcess.stderr?.resume();

  // Log fatal errors during startup
  wranglerProcess.on('error', (err) => {
    console.error('[wrangler setup] spawn error:', err.message);
  });

  wranglerProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[wrangler setup] exited with code ${code}`);
    }
  });

  await pollHealth(STARTUP_TIMEOUT_MS);

  // Return teardown function
  return async () => {
    if (wranglerProcess?.pid) {
      try {
        // Kill the entire process group (detached mode uses negative PID)
        process.kill(-wranglerProcess.pid, 'SIGTERM');
      } catch {
        // Process may already be dead
        try {
          wranglerProcess.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
      wranglerProcess = null;
    }
  };
}
