/** Exit codes the CLI can end with. */
export const ExitCode = {
	ok: 0,
	error: 1,
	/** What a shell reports when a process is stopped with Ctrl+C. */
	cancelled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error meant to be read by the person using the CLI, not a stack trace.
 *
 * Throw this whenever something goes wrong in a way you can explain. The message says what
 * went wrong, the optional hint says what to do about it, and both are printed without a
 * stack trace. Anything else that gets thrown is treated as a bug and printed in full.
 *
 * ```ts
 * throw new CliError('Flutter is not installed.', {
 *   hint: 'Run `smartify-os doctor` and it will set it up for you.',
 * });
 * ```
 */
export class CliError extends Error {
	/** What the user can do about it, printed under the message. */
	readonly hint: string | undefined;
	/** Code the process exits with. Defaults to 1. */
	readonly exitCode: number;
	/**
	 * What went wrong as data, for a program reading `--json`, for example the build errors
	 * of a change that did not fit. Never shown to a person, so it must not be the only place
	 * something they need to know is said.
	 */
	readonly details: unknown;

	constructor(
		message: string,
		options: { hint?: string; exitCode?: number; cause?: unknown; details?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = 'CliError';
		this.hint = options.hint;
		this.exitCode = options.exitCode ?? ExitCode.error;
		this.details = options.details;
	}
}

/**
 * Thrown when the user cancels a prompt with Ctrl+C.
 *
 * Internal: the wrappers in src/ui/prompt.ts throw this so no command has to check
 * clack's `isCancel` itself. The boundary in src/index.ts catches it and exits quietly.
 */
export class CancelledError extends Error {
	constructor(message = 'Cancelled.') {
		super(message);
		this.name = 'CancelledError';
	}
}
