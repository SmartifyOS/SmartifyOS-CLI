import type { ParseArgsConfig } from 'node:util';

/** The option spec of a single flag, in the shape `node:util`'s `parseArgs` wants. */
export type FlagSpec = NonNullable<ParseArgsConfig['options']>[string] & {
	/** One line shown next to the flag in `--help`. */
	describe: string;
};

/** Values `parseArgs` hands back for one command's flags. */
export type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** What a command gets to work with. */
export interface CommandContext {
	/** Parsed flags, already checked against the command's own {@link Command.flags}. */
	flags: Flags;
	/** Anything left over on the command line after the command name. */
	positionals: string[];
}

/**
 * One thing the CLI can do, for example `new` or `build`.
 *
 * Keep the command file itself thin. It reads flags, asks for whatever is missing, then
 * hands off to something in src/core, which is where the real work belongs. A command
 * must also work when nothing can be asked, so every prompt needs a matching flag.
 *
 * ```ts
 * export const buildCommand: Command = {
 *   name: 'build',
 *   summary: 'Build your system for the car',
 *   flags: {
 *     release: { type: 'boolean', describe: 'Build in release mode' },
 *   },
 *   async run({ flags }) {
 *     await buildProject({ release: flags.release === true });
 *   },
 * };
 * ```
 */
export interface Command {
	/** What the user types, for example `new`. */
	name: string;
	/** Other names that run the same command. */
	aliases?: string[];
	/** One line shown in the command list. Starts with a verb, no trailing period. */
	summary: string;
	/** Longer text shown by `smartify-os <name> --help`. */
	description?: string;
	/** Example command lines shown under the flags in `--help`. */
	examples?: string[];
	/** What goes after the name besides the flags, shown in `--help`: `<url>`, `[name]`. */
	usage?: string;
	/** Flags this command accepts, on top of the global ones. */
	flags?: Record<string, FlagSpec>;
	/**
	 * Commands grouped under this one, typed after its name: `extension add`. The group's
	 * own `run` is what happens when none of them is named.
	 */
	subcommands?: Command[];
	/** Hide from the command list. For internal or experimental commands. */
	hidden?: boolean;
	/**
	 * Part of running the tool rather than one of the things the tool is for. `help` and
	 * `update` are utilities, `build` is not. It only decides where a command is listed.
	 */
	utility?: boolean;
	/**
	 * Does the work. Returning means it worked. To fail, throw a `CliError` with a message
	 * the user can act on, and it decides the exit code.
	 */
	run(context: CommandContext): Promise<void> | void;
}
