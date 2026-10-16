import { runGroup } from '../../ui/group.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { deviceCreateCommand } from './create.ts';
import { deviceExportCommand } from './export.ts';
import { deviceFlashCommand } from './flash.ts';

/**
 * The devices on a car's CAN bus: the ESP32s around the car that the car's app defines, and
 * the program each of them runs. PlatformIO, which builds them, is set up by itself.
 */
export const deviceCommand: Command = {
	name: 'device',
	aliases: ['devices'],
	summary: 'Make and update the devices on your CAN bus',
	description:
		'The ESP32 boards around your car, on its CAN bus. Make the program of one, put it on its board over USB, or put new firmware for them on a USB stick for the car. DEVICES.md in the SmartifyOS repository is the full guide.',
	examples: [
		`${binaryName} device create`,
		`${binaryName} device flash --monitor`,
		`${binaryName} device export`,
	],
	subcommands: [deviceCreateCommand, deviceFlashCommand, deviceExportCommand],
	async run() {
		await runGroup(deviceCommand);
	},
};
