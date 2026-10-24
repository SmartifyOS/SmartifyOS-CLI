import { runGroup } from '../../ui/group.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { deviceCreateCommand } from './create.ts';
import { deviceEditCommand } from './edit.ts';
import { deviceExportCommand } from './export.ts';
import { deviceFlashCommand } from './flash.ts';
import { deviceListCommand } from './list.ts';

/**
 * The devices of a car: the ESP32s on its CAN bus, and the boards on a USB cable (an ESP32
 * or an Arduino), that the car's app defines, and the program each of them runs.
 * PlatformIO, which builds them, is set up by itself.
 */
export const deviceCommand: Command = {
	name: 'device',
	aliases: ['devices'],
	summary: 'Make and update the devices of your car',
	description:
		'The boards around your car: ESP32s on its CAN bus, or for a car with only one or two, a board on a USB cable (an ESP32 or an Arduino). Make the program of one, put it on its board over USB, put new firmware for them on a USB stick for the car, or list them. DEVICES.md in the SmartifyOS repository is the full guide.',
	examples: [
		`${binaryName} device create`,
		`${binaryName} device flash --monitor`,
		`${binaryName} device export`,
		`${binaryName} device create --usb`,
	],
	subcommands: [
		deviceCreateCommand,
		deviceFlashCommand,
		deviceExportCommand,
		deviceListCommand,
		deviceEditCommand,
	],
	async run() {
		await runGroup(deviceCommand);
	},
};
