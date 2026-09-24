import { runGroup } from '../../ui/group.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { extensionAddCommand } from './add.ts';
import { extensionCreateCommand } from './create.ts';
import { extensionListCommand } from './list.ts';
import { extensionReleaseCommand } from './release.ts';
import { extensionRemoveCommand } from './remove.ts';
import { extensionRunCommand } from './run.ts';
import { extensionUpdateCommand } from './update.ts';

/**
 * Everything about extensions, for a car's owner and for someone making one.
 *
 * The first four act on the car, like every other command, the last three on the
 * extension being made.
 */
export const extensionCommand: Command = {
	name: 'extension',
	aliases: ['extensions', 'ext'],
	summary: 'Add, update, remove or create extensions',
	description:
		'Extensions add features to your car, like Android Auto. Add, update and remove the ones in your car, or create and release your own.',
	examples: [
		`${binaryName} extension add https://github.com/Mauznemo/smartify_os_android_auto`,
		`${binaryName} extension list`,
		`${binaryName} extension create`,
	],
	subcommands: [
		extensionAddCommand,
		extensionUpdateCommand,
		extensionRemoveCommand,
		extensionListCommand,
		extensionCreateCommand,
		extensionRunCommand,
		extensionReleaseCommand,
	],
	async run() {
		await runGroup(extensionCommand);
	},
};
