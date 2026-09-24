import { binaryName, globalFlags, topLevelFlags } from '../commands/flags.ts';
import type { Command, FlagSpec } from '../commands/types.ts';
import { versionString } from '../utils/version.ts';
import { writeLine } from './output.ts';
import { symbols, theme } from './theme.ts';

/**
 * Everything `--help` and the `help` command put on screen.
 *
 * The command list is passed in rather than imported, so that the `help` command can call
 * this without the registry having to import it back. Keep it that way.
 */

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
