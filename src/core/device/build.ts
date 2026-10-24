import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { lastLines, run } from '../process.ts';
import { sha256OfFile } from '../self-update/release.ts';
import { cppName, type FirmwareSource, headerPath, readNodes } from './network.ts';
import { chipOfBoard, type DeviceProject, isUsbDevice, syncIni, versionMacro } from './project.ts';
import { platformioDir } from './tools.ts';

/**
 * Building a device's firmware with PlatformIO, and putting it on a board over USB.
 *
 * The version goes in as `SMARTIFY_OS_FIRMWARE_VERSION`, which the library sends in its
 * heartbeat when `begin()` is given none, so nobody ever writes a version in code. It is
 * handed over in `PLATFORMIO_BUILD_FLAGS` rather than written into platformio.ini, since the
 * CLI keeps it (see `DeviceSettings`), and has to be handed to the upload too, which would
 * otherwise build it again without.
 */

/** A finished build of a device's firmware. */
export interface BuiltFirmware {
	/**
	 * The app image, `.pio/build/<env>/firmware.bin`, not one merged with the bootloader, or
	 * an Arduino's `firmware.hex`.
	 */
	bin: string;
	size: number;
	sha256: string;
	/** `esp32`, `esp32s3`, `esp32c3`, as the stick names it. Undefined when unknown. */
	chip: string | undefined;
	version: string;
}

/**
 * What PlatformIO runs with for one version. Everything that runs `pio` in a device's
 * project needs it, the serial monitor too: run without, PlatformIO sees other build flags
 * and cleans the build, the `.elf` the exception decoder reads with it.
 */
export function buildEnv(version: string): Record<string, string> {
	return { PLATFORMIO_BUILD_FLAGS: `-D SMARTIFY_OS_FIRMWARE_VERSION=${versionMacro(version)}` };
}

/**
 * Checks that the car's header is there and has this device in it, which no device on the
 * CAN bus builds without. A board on USB needs none.
 *
 * @throws {CliError} saying what to do about it.
 */
export async function checkHeader(device: DeviceProject, appDir: string): Promise<void> {
	if (isUsbDevice(device)) return;
	const nodes = await readNodes(appDir);
	if (!nodes) {
		throw new CliError(`There is no ${headerPath} in your car's app yet.`, {
			hint: "SmartifyOS writes it while your car's app runs on this computer, once at least one message is defined. Run smartify-os run once, then try again.",
		});
	}
	const name = cppName(device.settings.device);
	if (!nodes.some((node) => node.name === name)) {
		throw new CliError(`${device.settings.device} is not in ${headerPath}.`, {
			hint: "Put it in CanConfig(devices: [...]) in your car's app, then run smartify-os run once, so SmartifyOS writes the header again.",
		});
	}
}

/**
 * Puts platformio.ini in step with the car's SmartifyOS, before anything is built or the code
 * is hashed, so a newer library counts as a change too.
 */
export async function syncDevice(device: DeviceProject, firmware: FirmwareSource): Promise<void> {
	// A board on USB has no SmartifyOS library, and its platform is its owner's.
	if (isUsbDevice(device)) return;
	const path = join(device.dir, 'platformio.ini');
	const text = await Bun.file(path).text();
	const synced = syncIni(text, firmware);
	if (synced !== text) await Bun.write(path, synced);
}

/**
 * Builds a device's firmware at a version.
 *
 * @throws {CliError} with the compiler's errors when it does not build, and when what it
 * built could never be updated over the bus.
 */
export async function buildDevice(device: DeviceProject, version: string): Promise<BuiltFirmware> {
	const env = requireEnv(device);
	const ini = await Bun.file(join(device.dir, 'platformio.ini')).text();
	const partitions = /^\s*board_build\.partitions\s*=\s*(\S+)/m.exec(ini)?.[1];
	const overBus = !isUsbDevice(device);
	if (overBus && partitions && /huge_app|no_ota/i.test(partitions)) {
		throw noRoomForUpdates(device, `platformio.ini picks the partition table ${partitions}`);
	}

	const result = await run('pio', ['run', '--project-dir', device.dir, '--environment', env], {
		cwd: device.dir,
		env: buildEnv(version),
	});
	if (result.code !== 0) {
		throw new CliError(`${device.settings.device} did not build.`, {
			hint: compilerErrors(`${result.stdout}\n${result.stderr}`),
		});
	}

	const folder = join(device.dir, '.pio', 'build', env);
	// An Arduino's firmware is a .hex.
	const bin = [join(folder, 'firmware.bin'), join(folder, 'firmware.hex')].find((path) =>
		existsSync(path),
	);
	if (!bin) {
		throw new CliError(
			`PlatformIO built ${device.settings.device}, but there is no firmware.bin.`,
			{
				hint: lastLines(result.stdout),
			},
		);
	}
	if (overBus) await checkPartitions(device, join(folder, 'partitions.bin'));

	return {
		bin,
		size: (await stat(bin)).size,
		sha256: await sha256OfFile(bin),
		chip: await chipOf(device),
		version,
	};
}

/**
 * Builds and puts a device's firmware on a board over USB: the bootloader, the partition
 * table, `boot_app0` and the app, so the device starts from a clean `otadata`.
 *
 * @throws {CliError} when the board could not be written.
 */
export async function flashDevice(
	device: DeviceProject,
	version: string,
	port: string,
): Promise<void> {
	const env = requireEnv(device);
	const result = await run(
		'pio',
		[
			'run',
			'--project-dir',
			device.dir,
			'--environment',
			env,
			'--target',
			'upload',
			'--upload-port',
			port,
		],
		{ cwd: device.dir, env: buildEnv(version) },
	);
	if (result.code !== 0) {
		throw new CliError(`${device.settings.device} could not be put on the board at ${port}.`, {
			hint: [
				"Check the USB cable carries data, not only power, and that nothing else (a serial monitor, or your car's app running on this computer) has the port open. Some boards need their BOOT button held down while it starts.",
				lastLines(`${result.stdout}\n${result.stderr}`, 8),
			].join('\n\n'),
		});
	}
}

/** A file esptool writes onto a board, and where in its flash it goes. */
export interface FlashImage {
	offset: number;
	path: string;
}

/**
 * Every file esptool writes onto an ESP32 on USB, in order, the app last: the bootloader,
 * the partition table and `boot_app0` from where PlatformIO says (`project metadata`), so the
 * car writes the board exactly the way `device flash` does.
 *
 * @throws {CliError} when PlatformIO does not say.
 */
export async function flashImages(
	device: DeviceProject,
	built: BuiltFirmware,
): Promise<FlashImage[]> {
	const env = requireEnv(device);
	const result = await run(
		'pio',
		['project', 'metadata', '--project-dir', device.dir, '--environment', env, '--json-output'],
		{ cwd: device.dir, env: buildEnv(built.version) },
	);
	const extra = (() => {
		try {
			const parsed = JSON.parse(result.stdout) as Record<string, { extra?: unknown }>;
			return parsed[env]?.extra as
				| { flash_images?: { offset?: string; path?: string }[]; application_offset?: string }
				| undefined;
		} catch {
			return undefined;
		}
	})();
	const appOffset = Number(extra?.application_offset);
	if (result.code !== 0 || !extra || !Number.isFinite(appOffset)) {
		throw new CliError(
			`PlatformIO did not say where ${device.settings.device} goes on its board.`,
			{
				hint: lastLines(`${result.stdout}\n${result.stderr}`, 8),
			},
		);
	}
	const images = (extra.flash_images ?? [])
		.map((image) => ({ offset: Number(image.offset), path: image.path ?? '' }))
		.filter((image) => Number.isFinite(image.offset) && image.path && existsSync(image.path));
	return [...images, { offset: appOffset, path: built.bin }];
}

/** Internal: the environment a device builds. */
function requireEnv(device: DeviceProject): string {
	if (device.env) return device.env;
	throw new CliError(`${join(device.dir, 'platformio.ini')} has no [env:...] to build.`, {
		hint: `Make it again with smartify-os device create, or put back the [env:${basename(device.dir)}] line.`,
	});
}

/** Internal: the compiler's errors in what PlatformIO printed, or else the end of it. */
export function compilerErrors(output: string): string {
	const errors = output
		.split(/\r?\n/)
		.filter((line) => /(^|\s|:)(fatal )?error:/i.test(line))
		.map((line) => line.trim());
	return errors.length > 0 ? [...new Set(errors)].slice(0, 10).join('\n') : lastLines(output, 20);
}

/**
 * Internal: refuses a build without room for updates over the bus: two app slots and
 * `otadata`. A board given one only ever takes new firmware over USB again, and says so.
 */
async function checkPartitions(device: DeviceProject, path: string): Promise<void> {
	const file = Bun.file(path);
	// Not every platform writes one into the build folder. The ini was checked already.
	if (!(await file.exists())) return;
	const table = readPartitions(new Uint8Array(await file.arrayBuffer()));
	const has = (type: number, subtype: number) =>
		table.some((entry) => entry.type === type && entry.subtype === subtype);
	if (!has(0, 0x10) || !has(0, 0x11) || !has(1, 0x00)) {
		throw noRoomForUpdates(device, 'its partition table has no second app slot');
	}
}

/** Internal: the entries of an ESP32 partition table. */
export function readPartitions(bytes: Uint8Array): { type: number; subtype: number }[] {
	const entries: { type: number; subtype: number }[] = [];
	for (let at = 0; at + 32 <= bytes.length; at += 32) {
		if (bytes[at] !== 0xaa || bytes[at + 1] !== 0x50) break;
		entries.push({ type: bytes[at + 2] ?? 0, subtype: bytes[at + 3] ?? 0 });
	}
	return entries;
}

function noRoomForUpdates(device: DeviceProject, why: string): CliError {
	return new CliError(`${device.settings.device} could never be updated over the bus: ${why}.`, {
		hint: 'Take board_build.partitions out of platformio.ini, so it gets the default partition table, which has room for updates.',
	});
}

/**
 * Internal: the chip on a device's board, from PlatformIO's description of the board (the
 * project's own `boards` folder, then the installed platforms), or else from the boards
 * SmartifyOS knows.
 *
 * @throws {CliError} for a board that is no ESP32 with CAN.
 */
async function chipOf(device: DeviceProject): Promise<string | undefined> {
	const board = device.board;
	if (!board) return undefined;
	const candidates = [join(device.dir, 'boards', `${board}.json`)];
	const platforms = join(platformioDir(), 'platforms');
	if (existsSync(platforms)) {
		for (const entry of await readdir(platforms)) {
			candidates.push(join(platforms, entry, 'boards', `${board}.json`));
		}
	}

	let chip: string | undefined;
	for (const path of candidates) {
		const file = Bun.file(path);
		if (!(await file.exists())) continue;
		try {
			const mcu = ((await file.json()) as { build?: { mcu?: unknown } }).build?.mcu;
			if (typeof mcu === 'string') chip = mcu.toLowerCase();
		} catch {
			// Not one PlatformIO could have read either.
		}
		if (chip) break;
	}
	chip ??= chipOfBoard(board);

	if (chip && (!chip.startsWith('esp32') || chip === 'esp32c2')) {
		throw new CliError(`The board ${board} has a ${chip}, which has no CAN.`, {
			hint: 'Use an ESP32, an ESP32-S3 or an ESP32-C3. Not the ESP32-C2.',
		});
	}
	return chip;
}
