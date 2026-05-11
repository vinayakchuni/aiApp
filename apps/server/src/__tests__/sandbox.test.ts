import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  buildDockerRunArgs,
  createSandbox,
  DEFAULT_CELL_TIMEOUT_MS,
  DEFAULT_SANDBOX_IMAGE,
  HARD_KILL_GRACE_MS,
  type DockerProcessHandle,
  type DockerRunner,
} from '../services/sandbox';

interface FakeProcessControl {
  handle: DockerProcessHandle;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  exit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  writtenInput: () => string;
  killCalls: NodeJS.Signals[];
}

function makeFakeProcess(): FakeProcessControl {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: string[] = [];
  stdin.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'));
  });
  const killCalls: NodeJS.Signals[] = [];
  let exitResolve!: (v: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    exitResolve = resolve;
  });
  const handle: DockerProcessHandle = {
    stdin,
    stdout,
    stderr,
    exited,
    kill(signal) {
      killCalls.push((signal ?? 'SIGTERM') as NodeJS.Signals);
      return true;
    },
  };
  return {
    handle,
    emitStdout: (chunk) => stdout.write(chunk),
    emitStderr: (chunk) => stderr.write(chunk),
    exit: (code, signal = null) => exitResolve({ code, signal }),
    writtenInput: () => chunks.join(''),
    killCalls,
  };
}

interface FakeRunnerControl {
  runner: DockerRunner;
  process: FakeProcessControl;
  runArgs: string[][];
  cpCalls: { src: string; dest: string }[];
  removeCalls: string[];
  killCalls: { name: string; signal: 'SIGINT' | 'SIGKILL' }[];
}

function makeFakeRunner(
  overrides: Partial<{
    cp: (src: string, dest: string) => Promise<void>;
    removeIfExists: (name: string) => Promise<void>;
    killSignal: (name: string, sig: 'SIGINT' | 'SIGKILL') => Promise<void>;
  }> = {},
): FakeRunnerControl {
  const process = makeFakeProcess();
  const runArgs: string[][] = [];
  const cpCalls: { src: string; dest: string }[] = [];
  const removeCalls: string[] = [];
  const killCalls: { name: string; signal: 'SIGINT' | 'SIGKILL' }[] = [];
  const runner: DockerRunner = {
    run(args) {
      runArgs.push([...args]);
      return process.handle;
    },
    async cp(src, dest) {
      cpCalls.push({ src, dest });
      if (overrides.cp) await overrides.cp(src, dest);
    },
    async removeIfExists(name) {
      removeCalls.push(name);
      if (overrides.removeIfExists) await overrides.removeIfExists(name);
    },
    async killSignal(name, signal) {
      killCalls.push({ name, signal });
      if (overrides.killSignal) await overrides.killSignal(name, signal);
    },
  };
  return { runner, process, runArgs, cpCalls, removeCalls, killCalls };
}

describe('buildDockerRunArgs', () => {
  it('produces every required security flag and the expected container name', () => {
    const args = buildDockerRunArgs({
      image: 'aiapp-sandbox',
      containerName: 'aiapp-sandbox-abc',
      memoryLimit: '256m',
      cpuLimit: '0.5',
      pidsLimit: 50,
    });
    expect(args).toContain('--network=none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--memory=256m');
    expect(args).toContain('--cpus=0.5');
    expect(args).toContain('--pids-limit=50');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--tmpfs=/tmp:rw,size=64m,mode=1777');
    expect(args).toContain('--tmpfs=/sandbox/data:rw,size=64m,mode=1777');
    expect(args).toContain('--tmpfs=/sandbox/work:rw,size=64m,mode=1777');
    // image must be the LAST positional arg (after all flags)
    expect(args[args.length - 1]).toBe('aiapp-sandbox');
    // --name must precede the value
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('aiapp-sandbox-abc');
  });

  it('uses --rm so the container is removed on exit', () => {
    const args = buildDockerRunArgs({
      image: 'x',
      containerName: 'c',
      memoryLimit: '256m',
      cpuLimit: '0.5',
      pidsLimit: 50,
    });
    expect(args).toContain('--rm');
  });
});

describe('createSandbox', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the default sandbox image when none is supplied', async () => {
    const { runner, process, runArgs } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c1' });
    const startPromise = sandbox.start();
    // Simulate the runner becoming ready
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;
    expect(runArgs).toHaveLength(1);
    expect(runArgs[0][runArgs[0].length - 1]).toBe(DEFAULT_SANDBOX_IMAGE);
    // Cleanly tear down
    process.exit(0);
    await sandbox.stop();
  });

  it('reports the configured container name and isRunning lifecycle', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'aiapp-test-xyz' });
    expect(sandbox.containerName).toBe('aiapp-test-xyz');
    expect(sandbox.isRunning).toBe(false);
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;
    expect(sandbox.isRunning).toBe(true);
    process.exit(0);
    await sandbox.stop();
    expect(sandbox.isRunning).toBe(false);
  });

  it('copies input files into /sandbox/data after the container is ready', async () => {
    const { runner, process, cpCalls } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-cp' });
    const startPromise = sandbox.start([
      { path: '/host/a.csv', containerName: 'a.csv' },
      { path: '/host/b.xlsx', containerName: 'b.xlsx' },
    ]);
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;
    expect(cpCalls).toEqual([
      { src: '/host/a.csv', dest: 'c-cp:/sandbox/data/a.csv' },
      { src: '/host/b.xlsx', dest: 'c-cp:/sandbox/data/b.xlsx' },
    ]);
    process.exit(0);
    await sandbox.stop();
  });

  it('sends one JSON-line request per execute() and resolves on the matching response', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-exec' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('print(1+1)');
    // Give the event loop a tick for stdin.write to flush
    await Promise.resolve();
    const written = process.writtenInput();
    expect(written).toBe(
      JSON.stringify({ code: 'print(1+1)', timeoutMs: DEFAULT_CELL_TIMEOUT_MS }) + '\n',
    );

    process.emitStdout(
      JSON.stringify({
        stdout: '2\n',
        stderr: '',
        images: [],
        timedOut: false,
      }) + '\n',
    );
    const out = await exec;
    expect(out).toEqual({
      stdout: '2\n',
      stderr: '',
      images: [],
      timedOut: false,
    });
    process.exit(0);
    await sandbox.stop();
  });

  it('preserves error and errorType fields when the runner reports a failed cell', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-err' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('1/0');
    process.emitStdout(
      JSON.stringify({
        stdout: '',
        stderr: 'ZeroDivisionError: division by zero\n',
        images: [],
        timedOut: false,
        error: 'ZeroDivisionError: division by zero',
        errorType: 'ZeroDivisionError',
      }) + '\n',
    );
    const out = await exec;
    expect(out.error).toBe('ZeroDivisionError: division by zero');
    expect(out.errorType).toBe('ZeroDivisionError');
    expect(out.timedOut).toBe(false);
    process.exit(0);
    await sandbox.stop();
  });

  it('passes through base64 PNG images from the runner', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-img' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('plt.plot([1,2,3]); plt.show()');
    process.emitStdout(
      JSON.stringify({
        stdout: '',
        stderr: '',
        images: ['iVBORw0KGgo=PNG1', 'iVBORw0KGgo=PNG2'],
        timedOut: false,
      }) + '\n',
    );
    const out = await exec;
    expect(out.images).toEqual(['iVBORw0KGgo=PNG1', 'iVBORw0KGgo=PNG2']);
    process.exit(0);
    await sandbox.stop();
  });

  it('forwards the per-cell timeoutMs override to the runner', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-to' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('x=1', { timeoutMs: 12345 });
    await Promise.resolve();
    expect(process.writtenInput()).toBe(
      JSON.stringify({ code: 'x=1', timeoutMs: 12345 }) + '\n',
    );
    process.emitStdout(
      JSON.stringify({ stdout: '', stderr: '', images: [], timedOut: false }) + '\n',
    );
    await exec;
    process.exit(0);
    await sandbox.stop();
  });

  it('handles fragmented stdout chunks across the JSON line boundary', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-frag' });
    const startPromise = sandbox.start();
    process.emitStdout('{"ready"');
    process.emitStdout(': true}\n');
    await startPromise;

    const exec = sandbox.execute('1+1');
    const wholeResponse = JSON.stringify({
      stdout: '2\n',
      stderr: '',
      images: [],
      timedOut: false,
    });
    // Split halfway through and across the newline
    process.emitStdout(wholeResponse.slice(0, 10));
    process.emitStdout(wholeResponse.slice(10));
    process.emitStdout('\n');
    const out = await exec;
    expect(out.stdout).toBe('2\n');
    process.exit(0);
    await sandbox.stop();
  });

  it('rejects start() if the container exits before sending ready', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-bad' });
    const startPromise = sandbox.start();
    process.emitStderr('docker: image not found\n');
    process.exit(125);
    await expect(startPromise).rejects.toThrow(/exited/);
    expect(sandbox.isRunning).toBe(false);
  });

  it('execute() throws when called before start()', async () => {
    const { runner } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-pre' });
    await expect(sandbox.execute('1')).rejects.toThrow(/not started/);
  });

  it('throws when execute() is called while another execution is pending', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-busy' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const first = sandbox.execute('x=1');
    await expect(sandbox.execute('y=2')).rejects.toThrow(/busy/);
    process.emitStdout(
      JSON.stringify({ stdout: '', stderr: '', images: [], timedOut: false }) + '\n',
    );
    await first;
    process.exit(0);
    await sandbox.stop();
  });

  it('hard-kills the container and resolves with timedOut=true when the runner does not reply within timeoutMs + grace', async () => {
    vi.useFakeTimers();
    const { runner, process, killCalls } = makeFakeRunner();
    const sandbox = createSandbox({
      docker: runner,
      containerName: 'c-timeout',
      cellTimeoutMs: 100,
    });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('while True: pass');
    // Advance past timeoutMs + grace
    vi.advanceTimersByTime(100 + HARD_KILL_GRACE_MS + 1);
    const out = await exec;
    expect(out.timedOut).toBe(true);
    expect(out.errorType).toBe('TimeoutError');
    expect(killCalls).toEqual([{ name: 'c-timeout', signal: 'SIGKILL' }]);
    expect(sandbox.isRunning).toBe(false);
  });

  it('start() can only be called once', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-once' });
    const first = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await first;
    await expect(sandbox.start()).rejects.toThrow(/already started/);
    process.exit(0);
    await sandbox.stop();
  });

  it('stop() writes a shutdown request and then removes the container', async () => {
    const { runner, process, removeCalls } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-stop' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const stopPromise = sandbox.stop();
    // Drain the shutdown line out of stdin and let the runner "exit"
    process.emitStdout(JSON.stringify({ goodbye: true }) + '\n');
    process.exit(0);
    await stopPromise;
    expect(removeCalls).toEqual(['c-stop']);
    const written = process.writtenInput();
    expect(written).toContain('"shutdown":true');
  });

  it('stop() force-kills the docker process if it does not exit within the grace window', async () => {
    vi.useFakeTimers();
    const { runner, process, removeCalls } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-force' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const stopPromise = sandbox.stop();
    // Don't emit goodbye, don't exit
    vi.advanceTimersByTime(3_000);
    // Now run microtasks
    await vi.runAllTimersAsync();
    process.exit(0);
    await stopPromise;
    expect(process.killCalls).toContain('SIGKILL');
    expect(removeCalls).toEqual(['c-force']);
  });

  it('stop() on a sandbox that never started is a no-op', async () => {
    const { runner, removeCalls } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-noop' });
    await sandbox.stop();
    expect(removeCalls).toEqual([]);
  });

  it('rejects a pending execute() when the container exits unexpectedly', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-crash' });
    const startPromise = sandbox.start();
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('1+1');
    process.emitStderr('segfault\n');
    process.exit(139);
    await expect(exec).rejects.toThrow(/exited/);
    expect(sandbox.isRunning).toBe(false);
  });

  it('ignores non-JSON stdout lines from the runner without breaking the protocol', async () => {
    const { runner, process } = makeFakeRunner();
    const sandbox = createSandbox({ docker: runner, containerName: 'c-noise' });
    const startPromise = sandbox.start();
    // Bury the ready signal under noise
    process.emitStdout('startup noise\n');
    process.emitStdout(JSON.stringify({ ready: true }) + '\n');
    await startPromise;

    const exec = sandbox.execute('1+1');
    process.emitStdout('not-json\n');
    process.emitStdout(
      JSON.stringify({ stdout: '2', stderr: '', images: [], timedOut: false }) + '\n',
    );
    const out = await exec;
    expect(out.stdout).toBe('2');
    process.exit(0);
    await sandbox.stop();
  });
});
