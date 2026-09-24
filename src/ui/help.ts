import { binaryName, globalFlags, topLevelFlags } from '../commands/flags.ts';
import type { Command, FlagSpec } from '../commands/types.ts';
import { buildSha, version, versionString } from '../utils/version.ts';
import { isJsonMode } from './json.ts';
import { writeLine } from './output.ts';
import { symbols, theme } from './theme.ts';

/**
 * Everything `--help` and the `help` command put on screen.
 *
 * The command list is passed in rather than imported, so that the `help` command can call
 * this without the registry having to import it back. Keep it that way.
 */

/**
 * The help for the whole CLI: printed for a person, or with `--json` handed back as data
 * for the closing `result` event.
 */
export function showRootHelp(
	list: readonly Command[],
): ReturnType<typeof describeRoot> | undefined {
	if (isJsonMode()) return describeRoot(list);
	renderRootHelp(list);
	return undefined;
}

/** The help for one command, the same way as {@link showRootHelp}. */
export function showCommandHelp(
	command: Command,
	parent?: Command,
): CommandDescription | undefined {
	if (isJsonMode()) return describeCommand(command, parent);
	renderCommandHelp(command, parent);
	return undefined;
}

/** Prints the list of commands, the global flags, and how to get more out of the CLI. */
export function renderRootHelp(list: readonly Command[]): void {
	writeLine();
	writeLine(`  ${theme.brand(theme.strong('SmartifyOS'))} ${theme.dim(versionString())}`);
	writeLine(`  ${theme.dim('Set up, build and run your own car infotainment system.')}`);
	writeLine();
	writeLine(`  ${theme.strong('Usage')}`);
	writeLine(`    ${binaryName} ${theme.dim('<command> [options]')}`);
	writeLine();
	writeLine(`  ${theme.strong('Commands')}`);

	const visible = list.filter((c) => !c.hidden);
	if (visible.length === 0) {
		writeLine(`    ${theme.dim('None yet, they are on their way.')}`);
	} else {
		const width = Math.max(...visible.map((c) => c.name.length));
		for (const c of visible) {
			writeLine(`    ${c.name.padEnd(width)}  ${theme.dim(c.summary)}`);
		}
	}

	renderFlags(topLevelFlags);

	writeLine();
	writeLine(
		`  ${theme.dim(`${symbols.arrow} Run ${theme.code(binaryName)} on its own for the guided menu.`)}`,
	);
	writeLine(
		`  ${theme.dim(`${symbols.arrow} Run ${theme.code(`${binaryName} help <command>`)} to read about one of them.`)}`,
	);
	writeLine();
}

/**
 * Prints what one command does, what it takes, and how it is used. `parent` is the group
 * it is in, for `extension add`.
 */
export function renderCommandHelp(command: Command, parent?: Command): void {
	const fullName = parent ? `${parent.name} ${command.name}` : command.name;
	const takes = command.subcommands?.length ? '<command>' : command.usage;

	writeLine();
	writeLine(`  ${theme.strong(`${binaryName} ${fullName}`)}`);
	writeLine(`  ${theme.dim(command.description ?? command.summary)}`);
	writeLine();
	writeLine(`  ${theme.strong('Usage')}`);
	writeLine(`    ${binaryName} ${fullName} ${theme.dim(`${takes ? `${takes} ` : ''}[options]`)}`);

	if (command.aliases?.length) {
		const prefix = parent ? `${binaryName} ${parent.name}` : binaryName;
		writeLine();
		writeLine(`  ${theme.strong('Also known as')}`);
		writeLine(`    ${command.aliases.map((alias) => `${prefix} ${alias}`).join(', ')}`);
	}

	const subcommands = command.subcommands?.filter((c) => !c.hidden) ?? [];
	if (subcommands.length > 0) {
		const width = Math.max(...subcommands.map((c) => c.name.length));
		writeLine();
		writeLine(`  ${theme.strong('Commands')}`);
		for (const c of subcommands) {
			writeLine(`    ${c.name.padEnd(width)}  ${theme.dim(c.summary)}`);
		}
	}

	renderFlags({ ...globalFlags, ...command.flags });

	if (command.examples?.length) {
		writeLine();
		writeLine(`  ${theme.strong('Examples')}`);
		for (const example of command.examples) {
			writeLine(`    ${theme.dim(example)}`);
		}
	}

	if (subcommands.length > 0) {
		writeLine();
		writeLine(
			`  ${theme.dim(`${symbols.arrow} Run ${theme.code(`${binaryName} help ${command.name} <command>`)} to read about one of them.`)}`,
		);
	}

	writeLine();
}

/** Internal: prints an aligned Options block. */
function renderFlags(spec: Record<string, FlagSpec>): void {
	const entries = Object.entries(spec);
	if (entries.length === 0) return;

	const labels = entries.map(([name, flag]) => {
		const short = flag.short ? `-${flag.short}, ` : '    ';
		return `${short}--${name}`;
	});
	const width = Math.max(...labels.map((label) => label.length));

	writeLine();
	writeLine(`  ${theme.strong('Options')}`);
	entries.forEach(([, flag], index) => {
		writeLine(`    ${(labels[index] ?? '').padEnd(width)}  ${theme.dim(flag.describe)}`);
	});
}

/** One flag, as `--help --json` describes it. */
export interface FlagDescription {
	name: string;
	type: 'boolean' | 'string';
	short?: string;
	multiple?: boolean;
	describe: string;
}

/** One command, as `--help --json` describes it, so a program can build a form from it. */
export interface CommandDescription {
	/** What is typed after the binary name, `extension add`. */
	command: string;
	name: string;
	aliases: string[];
	summary: string;
	description: string;
	/** What goes after the name besides the flags, `<url>`. */
	usage: string | undefined;
	examples: string[];
	/** Every flag it takes, the global ones included. */
	flags: FlagDescription[];
	subcommands: CommandDescription[];
	utility: boolean;
}

/** The whole CLI, as `--help --json` describes it. */
export function describeRoot(list: readonly Command[]) {
	return {
		binary: binaryName,
		version,
		sha: buildSha,
		flags: describeFlags(topLevelFlags),
		commands: list.filter((c) => !c.hidden).map((c) => describeCommand(c)),
	};
}

/** One command, as `smartify-os <command> --help --json` describes it. */
export function describeCommand(command: Command, parent?: Command): CommandDescription {
	return {
		command: parent ? `${parent.name} ${command.name}` : command.name,
		name: command.name,
		aliases: command.aliases ?? [],
		summary: command.summary,
		description: command.description ?? command.summary,
		usage: command.subcommands?.length ? '<command>' : command.usage,
		examples: command.examples ?? [],
		flags: describeFlags({ ...globalFlags, ...command.flags }),
		subcommands: (command.subcommands ?? [])
			.filter((c) => !c.hidden)
			.map((c) => describeCommand(c, command)),
		utility: command.utility === true,
	};
}

/** Internal: a flag spec as plain data. */
function describeFlags(spec: Record<string, FlagSpec>): FlagDescription[] {
	return Object.entries(spec).map(([name, flag]) => ({
		name,
		type: flag.type,
		...(flag.short ? { short: flag.short } : {}),
		...(flag.multiple ? { multiple: true } : {}),
		describe: flag.describe,
	}));
}
