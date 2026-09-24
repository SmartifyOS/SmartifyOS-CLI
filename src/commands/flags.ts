import type { FlagSpec } from './types.ts';

/**
 * The name of the tool and the flags that are not owned by any one command.
 *
 * These live in their own file rather than in src/cli.ts because both the parser and the
 * help renderer need them, and the help renderer must be reachable from a command without
 * dragging the whole command line in behind it.
 */

/** The name the user types. Kept in one place so help text can never drift from reality. */
export const binaryName = 'smartify-os';

/** Flags that work on every command. */
export const globalFlags: Record<string, FlagSpec> = {
	help: { type: 'boolean', short: 'h', describe: 'Show what this command can do' },
	yes: { type: 'boolean', short: 'y', describe: 'Say yes to every question, never ask' },
	json: {
		type: 'boolean',
		describe: 'Print one JSON event per line and take answers on stdin, for scripts and apps',
	},
};

/** Flags that only make sense before a command name. */
export const topLevelFlags: Record<string, FlagSpec> = {
	...globalFlags,
	version: { type: 'boolean', short: 'v', describe: 'Show which version is installed' },
};
