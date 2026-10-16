import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { type FirmwareSource, headerPath } from './network.ts';

/**
 * A device's project: the PlatformIO project of one ESP32 on a car's CAN bus, in a folder
 * of its own inside the car's app, `devices/<name>/`.
 *
 *   platformio.ini      what to build it for, see {@link renderIni}
 *   src/main.cpp        the device's program, the only file its owner touches
 *   smartify-os.json    what the CLI keeps about it, see {@link DeviceSettings}
 *   .gitignore          PlatformIO's build folder
 *
 * Inside the app rather than next to it, so it goes wherever the car's app goes (its git
 * repository included), and every device command finds the car from in there.
 */

/** The folder, inside the car's app, every device's project is in. */
export const devicesFolder = 'devices';

/** The file the CLI keeps a device's settings in. */
export const settingsName = 'smartify-os.json';

/** A board SmartifyOS has been tried on. */
export interface Board {
	/** PlatformIO's name for it. */
	id: string;
	/** What a person calls it. */
	label: string;
	/** The chip on it, as the stick names it (`CHIP=`). */
	chip: string;
	/** Other names it is found by, for `--board`. */
	aliases: string[];
}

/**
 * The boards SmartifyOS has been tried on. Any other ESP32 PlatformIO knows works too, by
 * its PlatformIO name, but not the ESP32-C2, which has no CAN.
 */
export const boards: Board[] = [
	{ id: 'esp32dev', label: 'ESP32 dev board', chip: 'esp32', aliases: ['esp32'] },
	{
		id: 'esp32-s3-devkitc-1',
		label: 'ESP32-S3',
		chip: 'esp32s3',
		aliases: ['esp32s3', 'esp32-s3', 's3'],
	},
	{
		id: 'esp32-c3-devkitm-1',
		label: 'ESP32-C3',
		chip: 'esp32c3',
		aliases: ['esp32c3', 'esp32-c3', 'c3'],
	},
];

/**
 * The PlatformIO board for what someone typed: one of {@link boards} by any of its names,
 * or else taken as a PlatformIO board name as it is.
 */
export function boardId(input: string): string {
	const wanted = input.trim().toLowerCase();
	const known = boards.find((board) => board.id === wanted || board.aliases.includes(wanted));
	return known?.id ?? input.trim();
}

/** The chip on a board, when it is one of {@link boards}. */
export function chipOfBoard(id: string): string | undefined {
	return boards.find((board) => board.id === id)?.chip;
}

/** `Pop-up headlights` becomes `popUpHeadlights`, the way the car's messages are named. */
export function deviceName(title: string): string {
	const words = title
		.normalize('NFKD')
		.replace(/[^A-Za-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean)
		.map((word) => word.toLowerCase());
	const name = words
		.map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
		.join('');
	return /^[0-9]/.test(name) ? `device${name}` : name || 'device';
}

/** What the CLI keeps about a device, in its {@link settingsName}. */
export interface DeviceSettings {
	/** `CanDevice.name`, which the stick names the firmware by. */
	device: string;
	/** The firmware's version, `1.0.0`, sent in the device's heartbeat. */
	version: string;
	/**
	 * What the code hashed to when this version was last built, see {@link codeHash}, so a
	 * change is noticed and the version raised. Null before the first build.
	 */
	code: string | null;
}

/** One device's project. */
export interface DeviceProject {
	dir: string;
	settings: DeviceSettings;
	/** The PlatformIO environment it builds, the first in platformio.ini. */
	env: string | undefined;
	/** PlatformIO's name for its board. */
	board: string | undefined;
}

/** The device project in a folder, or undefined when it is not one. */
export async function readDevice(dir: string): Promise<DeviceProject | undefined> {
	const file = Bun.file(join(dir, settingsName));
	if (!(await file.exists())) return undefined;
	const settings = parseSettings(await file.text());
	if (!settings) {
		throw new CliError(`${join(dir, settingsName)} is damaged.`, {
			hint: `It holds the device's name and version, like {"device": "headlights", "version": "1.0.0", "code": null}. Put that back and try again.`,
		});
	}
	const ini = Bun.file(join(dir, 'platformio.ini'));
	const text = (await ini.exists()) ? await ini.text() : '';
	return { dir, settings, env: envName(text), board: iniValue(text, 'board') };
}

/** Internal: the settings in a file, undefined when something in it is not what it should be. */
export function parseSettings(text: string): DeviceSettings | undefined {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		const { device, version, code } = raw;
		if (typeof device !== 'string' || !device) return undefined;
		if (typeof version !== 'string' || !isFirmwareVersion(version)) return undefined;
		if (code !== null && typeof code !== 'string') return undefined;
		return { device, version, code };
	} catch {
		return undefined;
	}
}

export async function writeSettings(dir: string, settings: DeviceSettings): Promise<void> {
	await Bun.write(join(dir, settingsName), `${JSON.stringify(settings, null, '\t')}\n`);
}

/** Every device project of a car, by name. */
export async function listDevices(appDir: string): Promise<DeviceProject[]> {
	const folder = join(appDir, devicesFolder);
	if (!existsSync(folder)) return [];
	const found: DeviceProject[] = [];
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const device = await readDevice(join(folder, entry.name));
		if (device) found.push(device);
	}
	return found.sort((a, b) => a.settings.device.localeCompare(b.settings.device));
}

/** The device project a folder is in, from the folder itself or one below it. */
export async function deviceAround(
	appDir: string,
	from: string,
): Promise<DeviceProject | undefined> {
	const inside = relative(join(appDir, devicesFolder), from);
	const name = inside.split(sep)[0];
	if (!name || name === '..' || inside.startsWith('..')) return undefined;
	return await readDevice(join(appDir, devicesFolder, name));
}

/** Internal: the first `[env:name]` in a platformio.ini. */
export function envName(ini: string): string | undefined {
	return /^\s*\[env:([^\]\s]+)\]/m.exec(ini)?.[1];
}

/** Internal: the first `key = value` in a platformio.ini. */
export function iniValue(ini: string, key: string): string | undefined {
	return new RegExp(`^\\s*${key}\\s*=\\s*(\\S.*?)\\s*$`, 'm').exec(ini)?.[1];
}

/** What a new device is. */
export interface NewDevice {
	/** Its name in `network::nodes`. */
	name: string;
	/** What a person calls it. */
	title: string;
	/** PlatformIO's name for its board. */
	board: string;
}

/**
 * platformio.ini for a device. The partition table is the board's default on purpose:
 * updates over the bus need its second app slot and `otadata`, and a "huge app" or "no OTA"
 * one would leave a device that only USB can ever update again.
 */
export function renderIni(device: NewDevice, firmware: FirmwareSource): string {
	return [
		`; ${device.title}, a device on your car's CAN bus. smartify-os builds it:`,
		';   smartify-os device flash    puts it on the board, over USB',
		';   smartify-os device export   puts it on a USB stick for the car',
		';',
		"; The platform and the SmartifyOS library follow your car's SmartifyOS, and are set",
		'; again every time it builds. Add libraries of your own under lib_deps.',
		'',
		`[env:${device.name}]`,
		`platform = ${firmware.platform}`,
		'framework = arduino',
		`board = ${device.board}`,
		'lib_deps =',
		`\t${firmware.library}#${firmware.version}`,
		'build_flags =',
		"\t; Where SmartifyOS writes the messages of your car's CAN bus, in your car's app.",
		`\t-I ../../${headerPath.split('/')[0]}`,
		'\t; What the library says over USB, which --monitor shows: what goes wrong (the pins,',
		'\t; the bus, safe mode) and how an update goes. 0 says nothing at all.',
		'\t-D CORE_DEBUG_LEVEL=3',
		'monitor_speed = 115200',
		'; A crash shows where in your code it happened, not only addresses.',
		'monitor_filters = esp32_exception_decoder',
		'',
	].join('\n');
}

/** src/main.cpp for a new device, the two calls every device needs and room for the rest. */
export function renderMain(device: Pick<NewDevice, 'name' | 'title'>): string {
	return `// ${device.title}, a device on your car's CAN bus.
//
// A normal Arduino program. Build it and put it on the board with
// \`smartify-os device flash\`, run in this folder.

#include <Arduino.h>
#include <SmartifyOsCan.h>
#include <smartify_os_network.h>

// The pins the CAN transceiver's TX and RX are wired to.
constexpr gpio_num_t canTx = GPIO_NUM_5;
constexpr gpio_num_t canRx = GPIO_NUM_4;

void setup() {
  // Always the first thing in setup(). A device that crashes again and again
  // stops right here and waits for new firmware, which only works when nothing
  // of yours ran before it.
  SmartifyOsCan.begin(network::nodes::${device.name}, canTx, canRx);

  // What to do when a message comes in, for example:
  // SmartifyOsCan.on<network::HeadlightsRequest>(
  //     [](const network::HeadlightsRequest& request) {
  //       moveLights(request.up);
  //     });

  // Your own setup goes here: pins, sensors, motors.
}

void loop() {
  // Always in loop(), and keep loop() quick: a device that does not get back
  // here for three seconds shows as stuck. Wait with millis(), not delay().
  SmartifyOsCan.update();

  // Your own code goes here, and sends what it has to say, for example:
  // network::HeadlightsState state;
  // state.leftAngle = 45;
  // SmartifyOsCan.send(state);
}
`;
}

/** The version a new device starts at. */
export const firstVersion = '1.0.0';

/**
 * Writes a new device's project into `devices/<name>/`.
 *
 * @throws {CliError} when that folder is there already.
 */
export async function createDevice(
	appDir: string,
	device: NewDevice & { device: string },
	firmware: FirmwareSource,
): Promise<{ dir: string; files: string[] }> {
	const dir = join(appDir, devicesFolder, device.name);
	if (existsSync(dir)) {
		throw new CliError(`There is a folder ${devicesFolder}/${device.name} already.`, {
			hint: 'That device has a project already. Build it with smartify-os device flash.',
		});
	}
	await mkdir(join(dir, 'src'), { recursive: true });
	const files: [string, string][] = [
		['platformio.ini', renderIni(device, firmware)],
		[join('src', 'main.cpp'), renderMain(device)],
		['.gitignore', '# What PlatformIO builds.\n.pio/\n'],
	];
	for (const [path, text] of files) await Bun.write(join(dir, path), text);
	await writeSettings(dir, { device: device.device, version: firstVersion, code: null });
	return { dir, files: [...files.map(([path]) => path), settingsName] };
}

/**
 * Puts the platform and the SmartifyOS library in platformio.ini in step with the
 * SmartifyOS the car runs, leaving every other line as its owner wrote it.
 *
 * @throws {CliError} when either line is gone.
 */
export function syncIni(ini: string, firmware: FirmwareSource): string {
	const platform = /^(\s*platform\s*=\s*)\S.*$/m;
	const library = /^(\s*(?:lib_deps\s*=\s*)?)(\S*SmartifyOS-ESP32[^\s#]*(?:#\S*)?)\s*$/im;
	if (!platform.test(ini) || !library.test(ini)) {
		throw new CliError("platformio.ini no longer names the platform or SmartifyOS's library.", {
			hint: `It needs a line platform = ${firmware.platform}, and ${firmware.library}#${firmware.version} under lib_deps.`,
		});
	}
	return ini
		.replace(platform, (_line, start: string) => `${start}${firmware.platform}`)
		.replace(library, (_line, start: string) => `${start}${firmware.library}#${firmware.version}`);
}

/**
 * What a device's code hashes to: every file of its project the CLI does not keep itself,
 * and the car's header, since a changed message changes the firmware too. Line endings are
 * left out, so a checkout on Windows hashes the same.
 */
export async function codeHash(device: DeviceProject, appDir: string): Promise<string> {
	const hasher = new Bun.CryptoHasher('sha256');
	const add = async (name: string, path: string) => {
		const file = Bun.file(path);
		const text = (await file.exists()) ? await file.text() : '';
		hasher.update(`${name}\0${text.replace(/\r\n/g, '\n')}\0`);
	};

	const files: string[] = [];
	const walk = async (dir: string) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			// .pio, .vscode, .gitignore and the like are not the device's code.
			if (entry.name.startsWith('.')) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && path !== join(device.dir, settingsName)) files.push(path);
		}
	};
	await walk(device.dir);
	for (const path of files.map((path) => relative(device.dir, path).split(sep).join('/')).sort()) {
		await add(path, join(device.dir, path));
	}
	await add(headerPath, join(appDir, headerPath));
	return hasher.digest('hex');
}

/** Whether this is a firmware version: three numbers, `1.2.0`, the way the stick names it. */
export function isFirmwareVersion(version: string): boolean {
	return /^\d+\.\d+\.\d+$/.test(version);
}

export type VersionPart = 'major' | 'minor' | 'patch';

/** A version with one part raised, and the parts after it back to 0. */
export function raiseVersion(version: string, part: VersionPart): string {
	const [major = 1, minor = 0, patch = 0] = version.split('.').map(Number);
	if (part === 'major') return `${major + 1}.0.0`;
	if (part === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** A version as the library's version macro wants it, `1,2,0`. */
export function versionMacro(version: string): string {
	return version.split('.').join(',');
}
