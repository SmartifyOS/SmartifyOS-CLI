import { runGroup } from '../../ui/group.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { exportAndroidCommand } from './android.ts';
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
		'Puts SmartifyOS on a USB stick for your car: an installer that sets up a new car, an update for a car that runs SmartifyOS already, or the app for an Android tablet.',
	examples: [
		`${binaryName} export installer`,
		`${binaryName} export update`,
		`${binaryName} export android`,
	],
	subcommands: [exportInstallerCommand, exportUpdateCommand, exportAndroidCommand],
	async run() {
		await runGroup(exportCommand);
	},
};
