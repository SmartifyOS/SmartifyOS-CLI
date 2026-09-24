import * as clack from '@clack/prompts';
import { CancelledError, CliError } from '../utils/errors.ts';
import { type ErrorPayload, emit, isJsonMode, type LogLevel } from './json.ts';
import { brandName, theme } from './theme.ts';

/**
 * Everything the CLI prints goes through this file, so that no command has to think about
 * streams, colors or how an error should look.
 */

/** Internal: the line under an unexpected error, for a person and a program alike. */
const reportBug =
	'This is a bug. Please report it at https://github.com/Mauznemo/SmartifyOS-CLI/issues';

/**
 * Write a line to stdout. This is the only place allowed to touch stdout directly, apart
 * from the JSON events in json.ts, which is what this turns into with `--json`.
 */
export function writeLine(line = ''): void {
	if (isJsonMode()) emit({ type: 'text', text: line });
	else process.stdout.write(`${line}\n`);
}

/**
 * Write a line to stderr, for anything that is not the actual output of a command. With
 * `--json` it is dropped, since a program asked for the events and nothing else.
 */
export function writeErrorLine(line = ''): void {
	if (!isJsonMode()) process.stderr.write(`${line}\n`);
}

/**
 * Whether an extra line on stderr would reach a person.
 *
 * False in CI and when stderr is a file or a pipe, where an unasked for notice is noise in
 * somebody's log rather than something anybody will read.
 */
export function canShowNotice(): boolean {
	return !isJsonMode() && clack.isTTY(process.stderr) && !clack.isCI();
}

/** Opens a prompt session with the SmartifyOS header. */
export function intro(title?: string): void {
	if (isJsonMode()) emit({ type: 'log', level: 'intro', text: title ?? 'SmartifyOS' });
	else clack.intro(title ? `${brandName()} ${theme.dim(theme.dim('·'))} ${title}` : brandName());
}

/** Closes a prompt session. */
export function outro(message: string): void {
	if (isJsonMode()) emit({ type: 'log', level: 'outro', text: message });
	else clack.outro(message);
}

/** Internal: one level of {@link log}, clack's for a person and an event for a program. */
function level(name: LogLevel & keyof typeof clack.log): (text: string, data?: unknown) => void {
	return (text, data) => {
		if (isJsonMode())
			emit({ type: 'log', level: name, text, ...(data === undefined ? {} : { data }) });
		else clack.log[name](text);
	};
}

/**
 * Lines inside a prompt session. `data` says the same thing as data, for a program reading
 * `--json`, and is never shown to a person.
 */
export const log = {
	info: level('info'),
	warn: level('warn'),
	error: level('error'),
	success: level('success'),
	message: level('message'),
	step: level('step'),
};

/**
 * Prints an error the way the user should see it.
 *
 * A {@link CliError} is printed as its message plus its hint, because it describes
 * something the user can fix. Anything else is a bug in the CLI, so it gets the full
 * stack and a line asking the user to report it.
 */
export function renderError(error: unknown): void {
	if (error instanceof CliError) {
		clack.log.error(theme.error(error.message));
		if (error.hint) {
			clack.log.message(theme.dim(error.hint));
		}
		return;
	}

	const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
	clack.log.error(theme.error('SmartifyOS ran into an unexpected problem.'));
	clack.log.message(theme.dim(stack));
	clack.log.message(theme.dim(reportBug));
}

/** The same as {@link renderError}, as data for the closing event of a `--json` run. */
export function errorPayload(error: unknown): ErrorPayload {
	if (error instanceof CancelledError) {
		return { kind: 'cancelled', message: 'Cancelled, nothing was changed.' };
	}
	if (error instanceof CliError) {
		return {
			kind: 'user',
			message: error.message,
			...(error.hint ? { hint: error.hint } : {}),
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	return {
		kind: 'bug',
		message: 'SmartifyOS ran into an unexpected problem.',
		hint: reportBug,
		stack: error instanceof Error ? (error.stack ?? error.message) : String(error),
	};
}
