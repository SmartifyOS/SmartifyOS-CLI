import { devicesFolder, listDevices } from '../../core/device/project.ts';
import { requireCar } from '../../core/project/find.ts';
import { isJsonMode } from '../../ui/json.ts';
import { writeLine } from '../../ui/output.ts';
import { theme } from '../../ui/theme.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { deviceData } from './shared.ts';

/**
 * Lists the devices of the car that have a program, the way `extension list` lists what it
 * runs: plain lines for a person, and every device as data for a program (the editor's car
 * panel is built on it).
 */
export const deviceListCommand: Command = {
	name: 'list',
	aliases: ['ls'],
	summary: 'List the devices on your CAN bus',
	description: `Lists the devices of your car that have a program, in ${devicesFolder}/, with the version of their firmware and their board. Run it in your car's app folder.`,
	examples: [`${binaryName} device list`],
	async run() {
		const app = await requireCar();
		const devices = (await listDevices(app.dir)).map((device) => deviceData(device, app.dir));
		const data = { devices };
		if (isJsonMode()) return data;

		writeLine();
		if (devices.length === 0) {
			writeLine(`  ${theme.dim(`No devices yet. Make one with ${binaryName} device create.`)}`);
		}
		const nameWidth = Math.max(0, ...devices.map((device) => device.name.length));
		const versionWidth = Math.max(0, ...devices.map((device) => device.version.length));
		for (const device of devices) {
			writeLine(
				`  ${device.name.padEnd(nameWidth)}  ${device.version.padEnd(versionWidth)}  ${theme.dim(device.board ?? '')}  ${theme.dim(device.folder)}`,
			);
		}
		writeLine();
		return data;
	},
};
