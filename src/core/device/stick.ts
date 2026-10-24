import { copyFile, mkdir, rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { version as cliVersion } from '../../utils/version.ts';
import { devicesOnStick, exportFolderName } from '../export/export.ts';
import { sha256OfFile } from '../self-update/release.ts';
import type { BuiltFirmware, FlashImage } from './build.ts';
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
 * A board on USB (see {@link UsbFirmware}) goes in the same folder: every file esptool or
 * avrdude writes, named after it, and a `.conf` saying `CONNECTION=usb` and how to write it
 * (`SerialFirmwareFiles` in core). The car offers both kinds in one notification.
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

/** How the car writes the firmware of a board on USB. */
export interface UsbFirmware {
	tool: 'esptool' | 'avrdude';
	/** For esptool, the chip (`esp32s3`); for avrdude, the microcontroller (`atmega328p`). */
	chip?: string;
	mcu?: string;
	/** How fast its bootloader talks. */
	uploadBaud?: number;
	/** For esptool, every file and where it goes, the app last. */
	images?: FlashImage[];
}

/** One file of a board on USB as it is on the stick. */
interface UsbFile {
	offset: number;
	file: string;
	sha256: string;
}

/**
 * `<device>.conf` of a board on USB: `CONNECTION=usb`, the tool, and `IMAGES` as
 * `offset:file:sha256` for esptool. `FILE`, `SIZE` and `SHA256` are the app, which tells one
 * firmware from the next.
 */
export function renderUsbDeviceConf(
	device: string,
	built: BuiltFirmware,
	usb: UsbFirmware,
	files: UsbFile[],
): string {
	const app = files[files.length - 1];
	const lines: [string, string | number | undefined][] = [
		['FORMAT', 1],
		['CONNECTION', 'usb'],
		['DEVICE', device],
		['TOOL', usb.tool],
		['CHIP', usb.chip],
		['MCU', usb.mcu],
		['UPLOAD_BAUD', usb.uploadBaud],
		['FILE', app?.file],
		['SIZE', built.size],
		['SHA256', built.sha256],
		[
			'IMAGES',
			usb.tool === 'esptool'
				? files.map((file) => `0x${file.offset.toString(16)}:${file.file}:${file.sha256}`).join(',')
				: undefined,
		],
	];
	return [
		`# Firmware for a board on USB, written by smartify-os ${cliVersion}.`,
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
	firmware: { device: string; built: BuiltFirmware; usb?: UsbFirmware }[],
): Promise<{ folder: string; files: string[] }> {
	const folder = join(target, exportFolderName, devicesOnStick);
	await mkdir(folder, { recursive: true });
	const files: string[] = [];
	for (const { device, built, usb } of firmware) {
		const name = fileName(device);
		if (usb) {
			files.push(...(await writeUsbFirmware(folder, name, device, built, usb)));
			continue;
		}
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

/** Internal: a board on USB's files, the app as `<device>.bin` or `.hex`, the rest after it. */
async function writeUsbFirmware(
	folder: string,
	name: string,
	device: string,
	built: BuiltFirmware,
	usb: UsbFirmware,
): Promise<string[]> {
	const images = usb.images ?? [{ offset: 0, path: built.bin }];
	const written: UsbFile[] = [];
	for (const [index, image] of images.entries()) {
		const last = index === images.length - 1;
		const file = last
			? `${name}${extname(image.path)}`
			: `${name}.${basename(image.path).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
		const path = join(folder, file);
		await copyFile(image.path, `${path}.new`);
		await rename(`${path}.new`, path);
		written.push({ offset: image.offset, file, sha256: await sha256OfFile(path) });
	}
	const conf = join(folder, `${name}.conf`);
	await Bun.write(`${conf}.new`, renderUsbDeviceConf(device, built, usb, written));
	await rename(`${conf}.new`, conf);
	return [
		...written.map((file) => `${devicesOnStick}/${file.file}`),
		`${devicesOnStick}/${name}.conf`,
	];
}

/** Internal: a device's files are named for it, in letters a FAT stick keeps. */
function fileName(device: string): string {
	return cppName(device);
}
