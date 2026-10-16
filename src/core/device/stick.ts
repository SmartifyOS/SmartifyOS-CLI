import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { version as cliVersion } from '../../utils/version.ts';
import { devicesOnStick, exportFolderName } from '../export/export.ts';
import type { BuiltFirmware } from './build.ts';
import { cppName } from './network.ts';

/**
 * Putting the firmware of a car's devices on a USB stick, in the same `smartify-os` folder an
 * update goes in, alone or next to one. SmartifyOS on the car reads it, and only reads it
 * (`CanFirmwareFiles` in core), and the driver updates each device from Settings, Vehicle,
 * Devices in the car:
 *
 *   devices/<device>.bin    the app image PlatformIO built
 *   devices/<device>.conf   what it is, see {@link renderDeviceConf}
 *
 * Every export keeps the folder, so an update exported after the firmware does not take it
 * away again.
 */

/**
 * `<device>.conf`: `KEY=value` lines. Keys are only ever added, and `FORMAT` goes up only
 * when an older SmartifyOS could not read the newer layout.
 */
export function renderDeviceConf(device: string, built: BuiltFirmware): string {
	const lines: [string, string | number | undefined][] = [
		['FORMAT', 1],
		['DEVICE', device],
		['FILE', `${fileName(device)}.bin`],
		['VERSION', built.version],
		['SIZE', built.size],
		['SHA256', built.sha256],
		['CHIP', built.chip],
	];
	return [
		`# Firmware for a device on the car's CAN bus, written by smartify-os ${cliVersion}.`,
		...lines.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`),
		'',
	].join('\n');
}

/**
 * Writes firmware into `target`, the root of the USB stick, next to whatever is there. The
 * image goes first and the `.conf` last, each swapped in whole, since the `.conf` is what
 * SmartifyOS looks for.
 */
export async function writeDeviceFirmware(
	target: string,
	firmware: { device: string; built: BuiltFirmware }[],
): Promise<{ folder: string; files: string[] }> {
	const folder = join(target, exportFolderName, devicesOnStick);
	await mkdir(folder, { recursive: true });
	const files: string[] = [];
	for (const { device, built } of firmware) {
		const name = fileName(device);
		const bin = join(folder, `${name}.bin`);
		await copyFile(built.bin, `${bin}.new`);
		await rename(`${bin}.new`, bin);
		const conf = join(folder, `${name}.conf`);
		await Bun.write(`${conf}.new`, renderDeviceConf(device, built));
		await rename(`${conf}.new`, conf);
		files.push(`${devicesOnStick}/${name}.bin`, `${devicesOnStick}/${name}.conf`);
	}
	return { folder: join(target, exportFolderName), files };
}

/** Internal: a device's files are named for it, in letters a FAT stick keeps. */
function fileName(device: string): string {
	return cppName(device);
}
