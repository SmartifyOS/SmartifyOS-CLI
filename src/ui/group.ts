import type { Command } from '../commands/types.ts';
import { showCommandHelp } from './help.ts';
import { isJsonMode } from './json.ts';
import { isInteractive, select } from './prompt.ts';

/**
 * What a group of commands, like `extension`, does when none of its commands is named:
 * asks which one, or prints the list when nobody can answer. With `--json` it is the list,
 * as data, since a program shows its own choices.
 */
export async function runGroup(group: Command): Promise<unknown> {
	const subcommands = group.subcommands?.filter((c) => !c.hidden) ?? [];

	// A program asked for the group on its own, which is a question about what is in it.
	if (!isInteractive() || isJsonMode() || subcommands.length === 0) {
		return showCommandHelp(group);
	}

	const choice = await select({
		message: 'What would you like to do?',
		options: subcommands.map((c) => ({ value: c.name, label: c.summary, hint: c.name })),
	});

	const subcommand = subcommands.find((c) => c.name === choice);
	return await subcommand?.run({ flags: {}, positionals: [] });
}
