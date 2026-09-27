import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { exportFlags, runExport } from './shared.ts';

/**
 * Puts an installer for a new car on a USB stick: install.sh, the car's app, and what the
 * car needs installed for it.
 */
export const exportInstallerCommand: Command = {
	name: 'installer',
	aliases: ['install'],
	summary: 'Put an installer for a new car on a USB stick',
	description:
		"Puts everything a new car needs on a USB stick: your car's app, what it needs installed on Linux, and install.sh, which sets the car up when you run it there once. SmartifyOS is built either on this computer, so the car only gets the finished app, or on the car itself. Run it in your car's app folder.",
	examples: [
		`${binaryName} export installer`,
		`${binaryName} export installer --to /Volumes/USB --build-on car`,
	],
	flags: exportFlags,
	async run({ flags }) {
		return await runExport('installer', flags);
	},
};
