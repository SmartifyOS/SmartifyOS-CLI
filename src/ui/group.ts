import type { Command } from '../commands/types.ts';
import { renderCommandHelp } from './help.ts';
import { isInteractive, select } from './prompt.ts';

/**
 * What a group of commands, like `extension`, does when none of its commands is named:
 * asks which one, or prints the list when nobody can answer.
 */
export async function runGroup(group: Command): Promise<void> {
	const subcommands = group.subcommands?.filter((c) => !c.hidden) ?? [];

	if (!isInteractive() || subcommands.length === 0) {
		renderCommandHelp(group);
		return;
	}

	const choice = await select({
		message: 'What would you like to do?',
		options: subcommands.map((c) => ({ value: c.name, label: c.summary, hint: c.name })),
	});

	const subcommand = subcommands.find((c) => c.name === choice);
	await subcommand?.run({ flags: {}, positionals: [] });
}
