import { runGroup } from '../../ui/group.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { exportInstallerCommand } from './installer.ts';
import { exportUpdateCommand } from './update.ts';

/**
 * Getting SmartifyOS onto a car, which is done with a USB stick: an installer for a new car,
 * or an update for one that runs SmartifyOS already.
 */
export const exportCommand: Command = {
	name: 'export',
	summary: 'Put SmartifyOS on a USB stick for your car',
	description:
		'Puts SmartifyOS on a USB stick for your car: an installer that sets up a new car, or an update for a car that runs SmartifyOS already.',
	examples: [`${binaryName} export installer`, `${binaryName} export update`],
	subcommands: [exportInstallerCommand, exportUpdateCommand],
	async run() {
		await runGroup(exportCommand);
	},
};
