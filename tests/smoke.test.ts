import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs the CLI the way a user does, as a real process.
 *
 * The unit tests cover the parsing, this covers the wiring: the entry point, the exit
 * codes, and that output actually reaches a pipe instead of getting cut off.
 */

const entry = join(import.meta.dir, '..', 'src', 'index.ts');

/** Somewhere throwaway for the CLI to keep its state, so no test writes into a real home. */
const stateDir = await mkdtemp(join(tmpdir(), 'smartify-os-smoke-'));

afterAll(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

/** What every run gets, on top of the caller's own environment. */
const sealedEnv = {
	// Force colors off so assertions match plain text.
	NO_COLOR: '1',
	// The update check must never run from a test. It would need the network, and it would
	// write into whoever is running the tests.
	SMARTIFY_OS_NO_UPDATE_CHECK: '1',
	SMARTIFY_OS_STATE_DIR: stateDir,
};

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, 'run', entry, ...args], {
		// Somewhere with no car and no extension above it, whoever runs the tests.
		cwd: stateDir,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...sealedEnv },
	});

	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { code, stdout, stderr };
}

describe('smartify-os', () => {
	test('--version prints a version and exits cleanly', async () => {
		const { code, stdout } = await runCli(['--version']);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+ \(.+\)$/);
	});

	test('--version says nothing on stderr, so a script gets exactly one line', async () => {
		const { stdout, stderr } = await runCli(['--version']);
		expect(stdout.trim().split('\n')).toHaveLength(1);
		expect(stderr).toBe('');
	});

	test('--help lists the usage and the commands, and exits cleanly', async () => {
		const { code, stdout } = await runCli(['--help']);
		expect(code).toBe(0);
		expect(stdout).toContain('SmartifyOS');
		expect(stdout).toContain('Usage');
		expect(stdout).toContain('smartify-os <command> [options]');
		expect(stdout).toContain('--version');
		expect(stdout).toContain('self-update');
		expect(stdout).toContain('help');
		expect(stdout).not.toContain('None yet');
	});

	test('help lists every command with what it does', async () => {
		const { code, stdout } = await runCli(['help']);
		expect(code).toBe(0);
		expect(stdout).toContain('Update the SmartifyOS CLI itself to the newest version');
		expect(stdout).toContain('Show what SmartifyOS can do');
	});

	test('help <command> explains that one command', async () => {
		const { code, stdout } = await runCli(['help', 'self-update']);
		expect(code).toBe(0);
		expect(stdout).toContain('smartify-os self-update');
		expect(stdout).toContain('Usage');
		expect(stdout).toContain('--check');
		expect(stdout).toContain('--to');
	});

	test('help for a command that does not exist fails readably', async () => {
		const { code, stdout, stderr } = await runCli(['help', 'nonsense']);
		expect(code).toBe(1);
		expect(stdout + stderr).toContain('There is no command called nonsense');
	});

	test('an unknown command fails with a readable message', async () => {
		const { code, stdout, stderr } = await runCli(['nonsense']);
		expect(code).toBe(1);
		expect(stdout + stderr).toContain('There is no command called nonsense');
	});

	test('an unknown flag fails with a readable message', async () => {
		const { code, stdout, stderr } = await runCli(['--nope']);
		expect(code).toBe(1);
		expect(stdout + stderr).toContain("Unknown option '--nope'");
	});

	test('no arguments outside a terminal still exits cleanly', async () => {
		const { code, stdout } = await runCli([]);
		expect(code).toBe(0);
		expect(stdout).toContain('SmartifyOS');
	});

	// This is the guard that stops a run from the source tree trying to replace a binary
	// that is not there. It fires before anything reaches the network, which is what makes
	// it safe to test the real self-update command here at all.
	test('self-update from the source tree refuses instead of doing something odd', async () => {
		for (const args of [['self-update'], ['self-update', '--check'], ['self-upgrade']]) {
			const { code, stdout, stderr } = await runCli(args);
			expect(code).toBe(1);
			expect(stdout + stderr).toContain('source code');
		}
	});

	// Nearly every command acts on a car, so outside one they have to say so, not crash.
	test('a car command outside a car says where to run it', async () => {
		for (const args of [['update'], ['extension', 'list'], ['link', '.'], ['unlink']]) {
			const { code, stdout, stderr } = await runCli(args);
			expect(code).toBe(1);
			expect(stdout + stderr).toContain('There is no SmartifyOS car here');
		}
	});

	test('extension --help lists what it can do', async () => {
		const { code, stdout } = await runCli(['extension', '--help']);
		expect(code).toBe(0);
		for (const name of ['add', 'update', 'remove', 'list', 'create', 'run', 'release']) {
			expect(stdout).toContain(`    ${name} `);
		}
	});

	test('help extension add explains that one', async () => {
		const { code, stdout } = await runCli(['help', 'extension', 'add']);
		expect(code).toBe(0);
		expect(stdout).toContain('smartify-os extension add <url> [options]');
		expect(stdout).toContain('--version');
	});

	test('extension on its own outside a terminal prints its commands', async () => {
		const { code, stdout } = await runCli(['extension']);
		expect(code).toBe(0);
		expect(stdout).toContain('smartify-os extension <command> [options]');
	});

	test('an unknown subcommand fails readably', async () => {
		const { code, stdout, stderr } = await runCli(['extension', 'nonsense']);
		expect(code).toBe(1);
		expect(stdout + stderr).toContain('There is no command called extension nonsense');
	});

	test('an extension command outside an extension says where to run it', async () => {
		const { code, stdout, stderr } = await runCli(['extension', 'run']);
		expect(code).toBe(1);
		expect(stdout + stderr).toContain('There is no extension here');
	});

	// `smartify-os --help | head` closes the pipe early. That has to be silent, not an
	// EPIPE stack trace. It showed up first on Linux, where the pipe timing differs.
	test('a reader that closes the pipe early is not an error', async () => {
		const proc = Bun.spawn(['sh', '-c', `"${process.execPath}" run "${entry}" --help | head -2`], {
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...sealedEnv },
		});

		const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

		expect(code).toBe(0);
		expect(stderr).not.toContain('EPIPE');
	});
});

/**
 * `--json`, which the GUI and AI agents drive the CLI with. Every line has to be JSON, the
 * first one `start` and the last one `result`, whatever happens in between.
 */
describe('smartify-os --json', () => {
	/** Internal: a run's events, checked for the shape every run has to have. */
	async function runJson(args: string[]) {
		const { code, stdout, stderr } = await runCli([...args, '--json']);
		expect(stderr).toBe('');
		const events = stdout
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(events[0]).toMatchObject({ type: 'start', protocol: 1 });
		const result = events.at(-1);
		expect(result.type).toBe('result');
		expect(result.exitCode).toBe(code);
		return { code, events, result };
	}

	test('--version is data', async () => {
		const { code, result } = await runJson(['--version']);
		expect(code).toBe(0);
		expect(result.data.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test('--help describes every command and its flags', async () => {
		const { result } = await runJson(['--help']);
		const names = result.data.commands.map((c: { name: string }) => c.name);
		expect(names).toContain('update');
		expect(names).toContain('extension');
		const extension = result.data.commands.find((c: { name: string }) => c.name === 'extension');
		const add = extension.subcommands.find((c: { name: string }) => c.name === 'add');
		expect(add.command).toBe('extension add');
		expect(add.flags.map((f: { name: string }) => f.name)).toContain('version');
	});

	test('no command is the command list, not the menu', async () => {
		const { code, result } = await runJson([]);
		expect(code).toBe(0);
		expect(result.data.commands.length).toBeGreaterThan(0);
	});

	test('a failure is a result with the message and the hint', async () => {
		const { code, events, result } = await runJson(['extension', 'list']);
		expect(code).toBe(1);
		expect(events[0].command).toBe('extension list');
		expect(result).toMatchObject({
			ok: false,
			error: { kind: 'user', message: 'There is no SmartifyOS car here.' },
		});
		expect(result.error.hint).toBeString();
	});

	test('a mistyped flag is reported as JSON too', async () => {
		const { code, result } = await runJson(['update', '--bogus']);
		expect(code).toBe(1);
		expect(result.error.message).toContain("Unknown option '--bogus'");
	});

	test('a question nobody answers fails and names the question', async () => {
		const { code, events, result } = await runJson(['extension', 'create']);
		expect(code).toBe(1);
		const prompt = events.find((e) => e.type === 'prompt');
		expect(prompt).toMatchObject({ id: 'p1', kind: 'text' });
		expect(result.error.details.prompt).toEqual(prompt);
	});

	test('an answer on stdin gets the command past its question', async () => {
		const proc = Bun.spawn([process.execPath, 'run', entry, 'extension', 'create', '--json'], {
			cwd: stateDir,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...sealedEnv },
		});
		// An empty name is refused, and the question stays open for the next answer.
		proc.stdin.write('{"id":"p1","value":""}\n');
		proc.stdin.end();
		const events = (await new Response(proc.stdout).text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		await proc.exited;
		expect(events.find((e) => e.type === 'prompt-invalid')).toMatchObject({ id: 'p1' });
	});
});
