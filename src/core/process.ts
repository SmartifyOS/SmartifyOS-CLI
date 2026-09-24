import { dirname } from 'node:path';
import { CliError } from '../utils/errors.ts';

/**
 * Running the tools the CLI hides: `flutter`, `dart` and `git`.
 *
 * Everything goes through here so that a missing tool is always the same friendly message,
 * and so that output is captured rather than sprayed over the prompts. Only `inherit` hands
 * the terminal over, for `flutter run`, where the user has to be able to press keys.
 */

export type Tool = 'flutter' | 'dart' | 'git';

/** What a finished process left behind. */
export interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Stops the process after this long. Nothing runs without one by default. */
	timeoutMs?: number;
}

const installHints: Record<Tool, string> = {
	flutter:
		'Install Flutter from https://docs.flutter.dev/get-started/install and open a new terminal.',
	dart: 'It comes with Flutter. Install Flutter from https://docs.flutter.dev/get-started/install and open a new terminal.',
	git: 'Install git from https://git-scm.com/downloads and open a new terminal.',
};

const toolNames: Record<Tool, string> = { flutter: 'Flutter', dart: 'Dart', git: 'git' };

/**
 * Where a tool is on this machine.
 *
 * `dart` is looked for next to `flutter` first. A separately installed Dart SDK is often a
 * different version from the one Flutter ships, and pub gets confused when the two mix.
 *
 * @throws {CliError} when it is not installed.
 */
export function findTool(tool: Tool): string {
	if (tool === 'dart') {
		const flutter = Bun.which('flutter');
		const bundled = flutter ? Bun.which('dart', { PATH: dirname(flutter) }) : null;
		if (bundled) return bundled;
	}

	const found = Bun.which(tool);
	if (found) return found;

	throw new CliError(`${toolNames[tool]} is not installed, and SmartifyOS needs it for this.`, {
		hint: installHints[tool],
	});
}

/** Internal: an environment that never waits for somebody to type a password. */
function quietEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
	return {
		...process.env,
		// A git url that does not exist, or needs logging in, asks for a username on the
		// terminal. Under a spinner nobody would ever see that question.
		GIT_TERMINAL_PROMPT: '0',
		// Flutter's first run banner and analytics notice are noise in captured output.
		FLUTTER_SUPPRESS_ANALYTICS: 'true',
		...extra,
	};
}

/** Runs a tool and collects what it printed. Never throws for a non zero exit code. */
export async function run(
	tool: Tool,
	args: string[],
	options: RunOptions = {},
): Promise<ProcessResult> {
	const proc = Bun.spawn([findTool(tool), ...args], {
		cwd: options.cwd,
		env: quietEnv(options.env),
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});

	const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;

	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Runs a tool and fails with a readable error when it does.
 *
 * The tool's own output goes into the error's hint, trimmed to the end, which is where
 * Flutter and git say what actually went wrong.
 */
export async function runOrThrow(
	tool: Tool,
	args: string[],
	failure: { message: string; hint?: string },
	options: RunOptions = {},
): Promise<ProcessResult> {
	const result = await run(tool, args, options);
	if (result.code === 0) return result;

	throw new CliError(failure.message, {
		hint: [failure.hint, lastLines(`${result.stdout}\n${result.stderr}`)]
			.filter(Boolean)
			.join('\n\n'),
	});
}

/**
 * Runs a tool in the user's own terminal, keys and colors included, and gives back its
 * exit code. For `flutter run`, which is interactive.
 */
export async function runInTerminal(tool: Tool, args: string[], cwd?: string): Promise<number> {
	const proc = Bun.spawn([findTool(tool), ...args], {
		cwd,
		env: { ...process.env },
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit',
	});
	return await proc.exited;
}

/** The last few lines of some output, which is where the reason for a failure is. */
export function lastLines(output: string, count = 15): string {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== '');
	return lines.slice(-count).join('\n');
}
