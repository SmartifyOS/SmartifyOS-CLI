#!/usr/bin/env bun
import * as clack from '@clack/prompts';
import { parse, run } from './cli.ts';
import { sweepReplacedBinary } from './core/self-update/install.ts';
import {
	closeInput,
	emit,
	enableJsonMode,
	isJsonMode,
	protocolVersion,
	wantsJson,
} from './ui/json.ts';
import { errorPayload, renderError } from './ui/output.ts';
import { maybeNotifyAboutUpdate } from './ui/self-update-notice.ts';
import { CancelledError, CliError, ExitCode } from './utils/errors.ts';
import { buildSha, version } from './utils/version.ts';

/**
 * The entry point, and the only place in the CLI that ends the process.
 *
 * Everything below it returns an exit code or throws, which is what lets the whole
 * command line be driven from a test without spawning anything.
 */
/**
 * Internal: `smartify-os --help | head` closes the pipe while we are still writing to it.
 * That is normal use, not a failure, so the write that lands afterwards has to be ignored
 * rather than turned into a stack trace in the user's face.
 */
function ignoreClosedPipes(): void {
	for (const stream of [process.stdout, process.stderr]) {
		stream.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'EPIPE') process.exit(ExitCode.ok);
			throw error;
		});
	}
}

async function main(argv: string[]): Promise<number> {
	if (isJsonMode()) {
		emit({
			type: 'start',
			protocol: protocolVersion,
			version,
			sha: buildSha,
			command: commandName(argv) ?? null,
		});
	}

	try {
		const data = await run(argv);
		if (isJsonMode()) emit({ type: 'result', ok: true, exitCode: ExitCode.ok, data: data ?? null });
		return ExitCode.ok;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') return ExitCode.ok;
		const code =
			error instanceof CancelledError
				? ExitCode.cancelled
				: error instanceof CliError
					? error.exitCode
					: ExitCode.error;

		if (isJsonMode())
			emit({ type: 'result', ok: false, exitCode: code, error: errorPayload(error) });
		else if (error instanceof CancelledError) clack.cancel('Cancelled, nothing was changed.');
		else renderError(error);
		return code;
	} finally {
		if (isJsonMode()) closeInput();
	}
}

/**
 * Internal: the command a run is for, `extension add`, for the `start` event. Undefined for
 * `--help`, `--version` and the menu, and when argv does not parse at all.
 */
function commandName(argv: string[]): string | undefined {
	try {
		const result = parse(argv);
		if (result.kind !== 'command') return undefined;
		return result.parent ? `${result.parent.name} ${result.command.name}` : result.command.name;
	} catch {
		return undefined;
	}
}

/**
 * Internal: the tidying up that happens once the user's command is out of the way.
 *
 * It runs here rather than at startup so that the update check can never be the reason a
 * command feels slow, and it is skipped after a failure, because an error on screen has
 * already used up the user's attention. Nothing in here is allowed to throw.
 */
async function afterCommand(argv: string[], code: number): Promise<void> {
	try {
		await sweepReplacedBinary();
		if (code !== ExitCode.ok) return;
		if (wasSelfUpdateCommand(argv)) return;
		await maybeNotifyAboutUpdate();
	} catch {
		// A check nobody asked for is never worth a message nobody asked for.
	}
}

/**
 * Internal: telling somebody to run `self-update` at the end of `self-update` would be daft.
 *
 * `parse` has no side effects, so asking it a second time costs nothing and is a good deal
 * safer than trying to read the command name out of argv by hand. It also resolves aliases,
 * so `self-upgrade` is caught here too.
 */
function wasSelfUpdateCommand(argv: string[]): boolean {
	try {
		const result = parse(argv);
		return result.kind === 'command' && result.command.name === 'self-update';
	} catch {
		return false;
	}
}

ignoreClosedPipes();

const argv = process.argv.slice(2);
// Before anything can print, so that even a mistyped flag is reported as JSON.
if (wantsJson(argv)) enableJsonMode();

// Called rather than awaited at the top level, because compiling to a standalone binary
// produces a format that has no top level await.
//
// The exit code is set before the tidying up, so that it is already correct whatever
// happens next. The process leaves with it once the event loop empties.
main(argv).then(async (code) => {
	process.exitCode = code;
	await afterCommand(argv, code);
});
