import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { exportFlags, runExport } from './shared.ts';

/**
 * Puts an update on a USB stick, for a car that runs SmartifyOS already: the car's app and
 * what it needs installed, laid out exactly as an installer, without install.sh. SmartifyOS
 * on the car applies it.
 */
export const exportUpdateCommand: Command = {
	name: 'update',
	summary: 'Put an update for your car on a USB stick',
	description:
		"Puts your car's app as it is now on a USB stick, with what it needs installed on Linux, for a car that runs SmartifyOS already. Plug the stick into the car and SmartifyOS there offers the update. Run it in your car's app folder.",
	examples: [`${binaryName} export update`, `${binaryName} export update --to /Volumes/USB`],
	flags: exportFlags,
	async run({ flags }) {
		return await runExport('update', flags);
	},
};
