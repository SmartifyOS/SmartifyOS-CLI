import { parseArgs } from 'node:util';
import { binaryName, globalFlags, topLevelFlags } from './commands/flags.ts';
import { commands, findCommand, visibleCommands } from './commands/index.ts';
import type { Command, FlagSpec, Flags } from './commands/types.ts';
import { renderCommandHelp, renderRootHelp } from './ui/help.ts';
import { runMenu } from './ui/menu.ts';
import { writeLine } from './ui/output.ts';
import { theme } from './ui/theme.ts';
import { CliError, ExitCode } from './utils/errors.ts';
import { closest } from './utils/suggest.ts';
import { versionString } from './utils/version.ts';

// Re-exported because this is where they were before, and where anyone would look first.
export { binaryName, globalFlags };

/** What the command line asked for. */
export type ParseResult =
	| { kind: 'version' }
	| { kind: 'help'; command?: Command; parent?: Command }
	| { kind: 'menu' }
	| { kind: 'command'; command: Command; parent?: Command; flags: Flags; positionals: string[] }
	| { kind: 'unknown'; name: string; suggestion: string | undefined };

/**
 * Works out what the user asked for, without doing any of it.
 *
 * Kept free of side effects on purpose. Nothing in here prints, exits or touches the
 * filesystem, which is what makes the whole command line surface testable, and what lets
 * src/index.ts ask it a second time after the command has run.
 *
 * @throws {CliError} when a flag is not recognised or is missing its value.
 */
export function parse(argv: string[]): ParseResult {
	const commandIndex = argv.findIndex((arg) => !arg.startsWith('-'));

	if (commandIndex === -1) {
		const flags = parseFlags(argv, topLevelFlags, binaryName);
		if (flags.version === true) return { kind: 'version' };
		if (flags.help === true) return { kind: 'help' };
		return { kind: 'menu' };
	}

	const name = argv[commandIndex] ?? '';
	const command = findCommand(name);
	const rest = [...argv.slice(0, commandIndex), ...argv.slice(commandIndex + 1)];

	if (!command) {
		const names = commands.filter((c) => !c.hidden).map((c) => c.name);
		return { kind: 'unknown', name, suggestion: closest(name, names) };
	}

	const subIndex = rest.findIndex((arg) => !arg.startsWith('-'));
	if (command.subcommands && subIndex !== -1) {
		const subName = rest[subIndex] ?? '';
		const subcommand = findIn(command.subcommands, subName);
		if (!subcommand) {
			const names = command.subcommands.filter((c) => !c.hidden).map((c) => c.name);
			const suggestion = closest(subName, names);
			return {
				kind: 'unknown',
				name: `${command.name} ${subName}`,
				suggestion: suggestion ? `${command.name} ${suggestion}` : undefined,
			};
		}

		const subRest = [...rest.slice(0, subIndex), ...rest.slice(subIndex + 1)];
		const spec = { ...globalFlags, ...subcommand.flags };
		const context = `${binaryName} ${command.name} ${subcommand.name}`;
		const { values, positionals } = parseFlagsAndPositionals(subRest, spec, context);

		if (values.help === true) return { kind: 'help', command: subcommand, parent: command };
		return { kind: 'command', command: subcommand, parent: command, flags: values, positionals };
	}

	const spec = { ...globalFlags, ...command.flags };
	const { values, positionals } = parseFlagsAndPositionals(rest, spec, `${binaryName} ${name}`);

	if (values.help === true) return { kind: 'help', command };

	return { kind: 'command', command, flags: values, positionals };
}

/** Internal: a command in a list by its name or one of its aliases. */
function findIn(list: Command[], name: string): Command | undefined {
	return list.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Internal: parseArgs for flags only, with its errors turned into readable ones. */
function parseFlags(argv: string[], spec: Record<string, FlagSpec>, context: string): Flags {
	return parseFlagsAndPositionals(argv, spec, context).values;
}

/** Internal: the one place `parseArgs` is called, so every flag error reads the same. */
function parseFlagsAndPositionals(
	argv: string[],
	spec: Record<string, FlagSpec>,
	context: string,
): { values: Flags; positionals: string[] } {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			options: spec,
			allowPositionals: true,
			strict: true,
		});
		return { values: values as Flags, positionals };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// parseArgs tacks a paragraph about `--` onto its errors, which only confuses
		// someone who just mistyped a flag. Keep the first sentence and drop the rest.
		const firstSentence = message.split('. ')[0] ?? message;
		throw new CliError(firstSentence.endsWith('.') ? firstSentence : `${firstSentence}.`, {
			hint: `Run ${theme.code(`${context} --help`)} to see the options it takes.`,
		});
	}
}

/**
 * Runs whatever the command line asked for and returns the exit code.
 *
 * Never calls `process.exit` itself. That belongs to src/index.ts alone, so that this
 * function can be called from a test.
 */
export async function run(argv: string[]): Promise<number> {
	const result = parse(argv);

	switch (result.kind) {
		case 'version':
			writeLine(versionString());
			return ExitCode.ok;

		case 'help':
			renderHelp(result.command, result.parent);
			return ExitCode.ok;

		case 'menu':
			return await runMenu();

		case 'unknown':
			throw new CliError(`There is no command called ${theme.strong(result.name)}.`, {
				hint: result.suggestion
					? `Did you mean ${theme.code(`${binaryName} ${result.suggestion}`)}?`
					: `Run ${theme.code(`${binaryName} --help`)} to see everything it can do.`,
			});

		case 'command':
			await result.command.run({ flags: result.flags, positionals: result.positionals });
			return ExitCode.ok;
	}
}

/** Prints the help for one command, or for the whole CLI when no command is given. */
export function renderHelp(command?: Command, parent?: Command): void {
	if (command) renderCommandHelp(command, parent);
	else renderRootHelp(visibleCommands());
}
