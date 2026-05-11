import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const DEFAULT_SANDBOX_IMAGE = 'aiapp-sandbox';
export const DEFAULT_CELL_TIMEOUT_MS = 30_000;
export const DEFAULT_MEMORY_LIMIT = '256m';
export const DEFAULT_CPU_LIMIT = '0.5';
export const DEFAULT_PIDS_LIMIT = 50;
export const HARD_KILL_GRACE_MS = 5_000;
const READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 4096;

export type CodeExecutionOutput = {
  stdout: string;
  stderr: string;
  images: string[];
  timedOut: boolean;
  error?: string;
  errorType?: string;
};

export interface SandboxFile {
  /** Absolute path on the host filesystem. */
  path: string;
  /** Filename to expose inside the container at /sandbox/data/<name>. */
  containerName: string;
}

export interface ExecuteOptions {
  timeoutMs?: number;
}

export interface Sandbox {
  start(files?: readonly SandboxFile[]): Promise<void>;
  execute(code: string, opts?: ExecuteOptions): Promise<CodeExecutionOutput>;
  stop(): Promise<void>;
  readonly containerName: string;
  readonly isRunning: boolean;
}

export interface DockerProcessHandle {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Pluggable seam so the service can be unit-tested without Docker. */
export interface DockerRunner {
  run(args: readonly string[]): DockerProcessHandle;
  cp(src: string, dest: string): Promise<void>;
  removeIfExists(name: string): Promise<void>;
  killSignal(name: string, signal: 'SIGINT' | 'SIGKILL'): Promise<void>;
}

export interface CreateSandboxOptions {
  image?: string;
  cellTimeoutMs?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  containerName?: string;
  docker?: DockerRunner;
}

export function buildDockerRunArgs(params: {
  image: string;
  containerName: string;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
}): string[] {
  return [
    'run',
    '-i',
    '--rm',
    '--name',
    params.containerName,
    '--network=none',
    '--read-only',
    `--memory=${params.memoryLimit}`,
    `--cpus=${params.cpuLimit}`,
    `--pids-limit=${params.pidsLimit}`,
    '--security-opt=no-new-privileges',
    '--tmpfs=/tmp:rw,size=64m,mode=1777',
    '--tmpfs=/sandbox/data:rw,size=64m,mode=1777',
    '--tmpfs=/sandbox/work:rw,size=64m,mode=1777',
    '-w',
    '/sandbox/work',
    params.image,
  ];
}

export function createSandbox(options: CreateSandboxOptions = {}): Sandbox {
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const defaultTimeout = options.cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS;
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const cpuLimit = options.cpuLimit ?? DEFAULT_CPU_LIMIT;
  const pidsLimit = options.pidsLimit ?? DEFAULT_PIDS_LIMIT;
  const containerName =
    options.containerName ?? `aiapp-sandbox-${randomUUID()}`;
  const docker = options.docker ?? defaultDockerRunner();

  type Pending = {
    resolve: (out: CodeExecutionOutput) => void;
    reject: (err: Error) => void;
    timers: NodeJS.Timeout[];
  };

  let proc: DockerProcessHandle | null = null;
  let pending: Pending | null = null;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  let started = false;
  let dead = false;

  function settlePending(out: CodeExecutionOutput): void {
    const p = pending;
    if (!p) return;
    pending = null;
    p.timers.forEach((t) => clearTimeout(t));
    p.resolve(out);
  }

  function rejectPending(err: Error): void {
    const p = pending;
    if (!p) return;
    pending = null;
    p.timers.forEach((t) => clearTimeout(t));
    p.reject(err);
  }

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn(
        `sandbox(${containerName}): non-JSON line from runner: ${trimmed.slice(0, 200)}`,
      );
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const obj = parsed as Record<string, unknown>;
    if (obj.ready === true) {
      const cb = readyResolve;
      readyResolve = null;
      readyReject = null;
      cb?.();
      return;
    }
    if (obj.goodbye === true) return;
    settlePending(normalizeOutput(obj));
  }

  function ingestStdout(chunk: Buffer): void {
    stdoutBuffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      handleLine(line);
    }
  }

  function ingestStderr(chunk: Buffer): void {
    stderrTail += chunk.toString('utf8');
    if (stderrTail.length > STDERR_TAIL_BYTES) {
      stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
    }
  }

  async function start(files: readonly SandboxFile[] = []): Promise<void> {
    if (started) throw new Error('sandbox already started');
    started = true;

    const handle = docker.run(
      buildDockerRunArgs({
        image,
        containerName,
        memoryLimit,
        cpuLimit,
        pidsLimit,
      }),
    );
    proc = handle;

    handle.stdout.on('data', ingestStdout);
    handle.stderr.on('data', ingestStderr);

    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimeout = setTimeout(() => {
      const cb = readyReject;
      readyResolve = null;
      readyReject = null;
      cb?.(
        new Error(
          `sandbox container did not become ready within ${READY_TIMEOUT_MS}ms`,
        ),
      );
    }, READY_TIMEOUT_MS);

    handle.exited
      .then(({ code, signal }) => {
        dead = true;
        const exitErr = new Error(
          `sandbox container exited (code=${code}, signal=${signal}): ${stderrTail.slice(-500)}`,
        );
        const readyCb = readyReject;
        readyResolve = null;
        readyReject = null;
        readyCb?.(exitErr);
        rejectPending(exitErr);
      })
      .catch(() => undefined);

    try {
      await readyPromise;
    } finally {
      clearTimeout(readyTimeout);
    }

    for (const file of files) {
      await docker.cp(
        file.path,
        `${containerName}:/sandbox/data/${file.containerName}`,
      );
    }
  }

  async function execute(
    code: string,
    opts: ExecuteOptions = {},
  ): Promise<CodeExecutionOutput> {
    if (!proc) throw new Error('sandbox not started');
    if (dead) throw new Error('sandbox is no longer running');
    if (pending) throw new Error('sandbox is busy with another execution');
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const handle = proc;

    return await new Promise<CodeExecutionOutput>((resolve, reject) => {
      const timers: NodeJS.Timeout[] = [];
      pending = { resolve, reject, timers };

      const hardKill = setTimeout(() => {
        if (!pending) return;
        const cb = pending;
        pending = null;
        cb.timers.forEach((t) => clearTimeout(t));
        dead = true;
        docker.killSignal(containerName, 'SIGKILL').catch(() => undefined);
        cb.resolve({
          stdout: '',
          stderr: '',
          images: [],
          timedOut: true,
          error: `Execution exceeded hard timeout of ${timeoutMs + HARD_KILL_GRACE_MS}ms; sandbox terminated`,
          errorType: 'TimeoutError',
        });
      }, timeoutMs + HARD_KILL_GRACE_MS);
      timers.push(hardKill);

      try {
        handle.stdin.write(JSON.stringify({ code, timeoutMs }) + '\n');
      } catch (err) {
        rejectPending(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async function stop(): Promise<void> {
    if (!started || !proc) return;
    const handle = proc;
    proc = null;
    rejectPending(new Error('sandbox stopped while execution pending'));

    try {
      handle.stdin.write(JSON.stringify({ shutdown: true }) + '\n');
      handle.stdin.end();
    } catch {
      // ignore — process may already be gone
    }

    const exited = handle.exited
      .then(() => 'exited' as const)
      .catch(() => 'exited' as const);
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), STOP_GRACE_MS),
    );
    const outcome = await Promise.race([exited, timeout]);
    if (outcome === 'timeout') {
      try {
        handle.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    await docker.removeIfExists(containerName).catch(() => undefined);
    dead = true;
  }

  return {
    start,
    execute,
    stop,
    get containerName() {
      return containerName;
    },
    get isRunning() {
      return started && !dead;
    },
  };
}

function normalizeOutput(obj: Record<string, unknown>): CodeExecutionOutput {
  const images = Array.isArray(obj.images)
    ? (obj.images as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const out: CodeExecutionOutput = {
    stdout: typeof obj.stdout === 'string' ? obj.stdout : '',
    stderr: typeof obj.stderr === 'string' ? obj.stderr : '',
    images,
    timedOut: obj.timedOut === true,
  };
  if (typeof obj.error === 'string') out.error = obj.error;
  if (typeof obj.errorType === 'string') out.errorType = obj.errorType;
  return out;
}

function defaultDockerRunner(): DockerRunner {
  return {
    run(args) {
      const child = spawn('docker', [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });
      const stdin = child.stdin;
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdin || !stdout || !stderr) {
        throw new Error('docker child process is missing one of stdin/stdout/stderr');
      }
      return {
        stdin,
        stdout,
        stderr,
        exited,
        kill(signal) {
          return child.kill(signal);
        },
      };
    },
    async cp(src, dest) {
      await runDockerOnce(['cp', src, dest]);
    },
    async removeIfExists(name) {
      try {
        await runDockerOnce(['rm', '-f', name]);
      } catch {
        // best-effort
      }
    },
    async killSignal(name, signal) {
      try {
        await runDockerOnce(['kill', `--signal=${signal}`, name]);
      } catch {
        // best-effort
      }
    },
  };
}

async function runDockerOnce(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(`docker ${args.join(' ')} exited with code ${code}: ${stderr}`),
        );
    });
  });
}
