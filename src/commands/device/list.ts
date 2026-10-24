import { definedDevices } from '../../core/device/app.ts';
import { devicesFolder, listDevices } from '../../core/device/project.ts';
import { definedSerialDevices } from '../../core/device/serial-app.ts';
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
 * panel is built on it). `defined` is every device the car's app defines on its CAN bus,
 * and `usb` every board on a USB cable (`SerialDevice`), with a program or not, so the
 * editor knows them while the app is not running.
 */
export const deviceListCommand: Command = {
	name: 'list',
	aliases: ['ls'],
	summary: 'List the devices of your car',
	description: `Lists the devices of your car that have a program, in ${devicesFolder}/, with the version of their firmware and their board, and the ones your app has on its CAN bus or on USB that have none yet. Run it in your car's app folder.`,
	examples: [`${binaryName} device list`],
	async run() {
		const app = await requireCar();
		const devices = (await listDevices(app.dir)).map((device) => deviceData(device, app.dir));
		const defined = await definedDevices(app.dir);
		const usb = await definedSerialDevices(app.dir);
		const data = { devices, defined, usb };
		if (isJsonMode()) return data;

		writeLine();
		const withoutProgram = [
			...defined.map((device) => ({ name: device.name, usb: false })),
			...usb.map((device) => ({ name: device.name, usb: true })),
		].filter((device) => !devices.some((known) => known.name === device.name));
		if (devices.length === 0 && withoutProgram.length === 0) {
			writeLine(`  ${theme.dim(`No devices yet. Make one with ${binaryName} device create.`)}`);
		}
		const nameWidth = Math.max(0, ...devices.map((device) => device.name.length));
		const shown = (device: (typeof devices)[number]) =>
			device.connection === 'usb' ? 'USB' : device.version;
		const versionWidth = Math.max(0, ...devices.map((device) => shown(device).length));
		for (const device of devices) {
			writeLine(
				`  ${device.name.padEnd(nameWidth)}  ${shown(device).padEnd(versionWidth)}  ${theme.dim(device.board ?? '')}  ${theme.dim(device.folder)}`,
			);
		}
		for (const device of withoutProgram) {
			writeLine(
				`  ${device.name}  ${theme.dim(device.usb ? '(on USB, no program yet)' : '(no program yet)')}`,
			);
		}
		writeLine();
		return data;
	},
};
