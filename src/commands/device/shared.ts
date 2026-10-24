import { basename } from 'node:path';
import {
	type BuiltFirmware,
	buildDevice,
	checkHeader,
	syncDevice,
} from '../../core/device/build.ts';
import type { FirmwareSource } from '../../core/device/network.ts';
import { hasBuiltBefore, setUpPlatformio } from '../../core/device/platformio.ts';
import {
	codeHash,
	type DeviceProject,
	deviceAround,
	isUsbDevice,
	listDevices,
	raiseVersion,
	type VersionPart,
	writeSettings,
} from '../../core/device/project.ts';
import { step } from '../../ui/project.ts';
import { select, spinner } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { pubPath } from '../../utils/pub-path.ts';
import { binaryName } from '../flags.ts';
import type { FlagSpec, Flags } from '../types.ts';

/**
 * What `device flash` and `device export` share: finding the device, setting PlatformIO up,
 * and building it at the right version.
 */

/** The flag both take for the version, so neither ever has to ask. */
export const raiseFlag: Record<string, FlagSpec> = {
	raise: {
		type: 'string',
		describe: 'Raise the firmware version first: patch, minor, major, or no',
	},
};

/** Internal: the answers `--raise` takes. */
const raiseValues = ['patch', 'minor', 'major', 'no'] as const;

/** A device, the way `--json` reports one. Its folder is relative to the car's app. */
export function deviceData(device: DeviceProject, appDir: string) {
	return {
		name: device.settings.device,
		folder: pubPath(appDir, device.dir),
		version: device.settings.version,
		board: device.board ?? null,
		connection: isUsbDevice(device) ? 'usb' : 'can',
	};
}

/**
 * The devices to work on: the ones named, or else the one whose folder this is.
 *
 * @throws {CliError} when the car has none, or one named is not one of them.
 */
export async function findDevices(
	appDir: string,
	names: string[],
): Promise<{ all: DeviceProject[]; named: DeviceProject[]; here: DeviceProject | undefined }> {
	const all = await listDevices(appDir);
	if (all.length === 0) {
		throw new CliError('Your car has no devices yet.', {
			hint: `Make one with ${theme.code(`${binaryName} device create`)}.`,
		});
	}
	const named = names.map((name) => {
		const found = all.find(
			(device) => device.settings.device === name || basename(device.dir) === name,
		);
		if (found) return found;
		throw new CliError(`Your car has no device called ${name}.`, {
			hint: `It has ${all.map((device) => theme.strong(device.settings.device)).join(', ')}.`,
		});
	});
	return { all, named, here: await deviceAround(appDir, process.cwd()) };
}

/** Sets PlatformIO up the first time, under a spinner. */
export async function ensurePlatformio(): Promise<void> {
	const progress = spinner();
	let started = false;
	try {
		await setUpPlatformio((which) => {
			const text =
				which === 'uv'
					? 'Setting up PlatformIO, which builds the firmware (only the first time)'
					: 'Installing PlatformIO and its Python (only the first time, about a minute)';
			if (started) progress.message(text);
			else progress.start(text);
			started = true;
		});
		if (started) progress.stop('Set up PlatformIO, which builds the firmware');
	} catch (error) {
		if (started) progress.error('PlatformIO could not be set up');
		throw error;
	}
}

/**
 * Builds a device at the version it should have: its own, or raised when its code changed
 * since that version was built, by the flag or by asking. Remembers the version and the
 * code once it built.
 */
export async function buildAtVersion(
	device: DeviceProject,
	appDir: string,
	firmware: FirmwareSource,
	flags: Flags,
): Promise<{ built: BuiltFirmware; raised: boolean }> {
	const name = theme.strong(device.settings.device);
	await syncDevice(device, firmware);
	await checkHeader(device, appDir);
	const code = await codeHash(device, appDir);
	const version = await pickVersion(device, code, flags);
	const raised = version !== device.settings.version;

	const first = hasBuiltBefore() ? '' : ' (the first build downloads the tools, a few minutes)';
	// A board on USB has no version anyone sees.
	const shown = isUsbDevice(device) ? name : `${name} ${version}`;
	const built = await step(
		`Building ${shown}${first}`,
		() => buildDevice(device, version),
		(built) => `Built ${shown}, ${Math.round(built.size / 1024)} KB`,
	);
	device.settings = { ...device.settings, version, code };
	await writeSettings(device.dir, device.settings);
	return { built, raised };
}

/** Internal: the version to build. */
async function pickVersion(device: DeviceProject, code: string, flags: Flags): Promise<string> {
	const current = device.settings.version;
	if (isUsbDevice(device)) return current;
	const given = flags.raise;
	if (given !== undefined) {
		if (!raiseValues.includes(given as (typeof raiseValues)[number])) {
			throw new CliError(`--raise is patch, minor, major or no, not ${String(given)}.`, {
				hint: `${theme.code('--raise patch')} for a fix, ${theme.code('--raise no')} to keep ${current}.`,
			});
		}
		return given === 'no' ? current : raiseVersion(current, given as VersionPart);
	}

	const changed = device.settings.code !== null && device.settings.code !== code;
	if (!changed) return current;
	if (flags.yes === true) return raiseVersion(current, 'patch');

	const part = await select<VersionPart | 'no'>({
		message: `${theme.strong(device.settings.device)} changed since ${current} was built. Raise its version?`,
		options: [
			{ value: 'patch', label: `To ${raiseVersion(current, 'patch')}`, hint: 'a fix' },
			{ value: 'minor', label: `To ${raiseVersion(current, 'minor')}`, hint: 'something new' },
			{ value: 'major', label: `To ${raiseVersion(current, 'major')}`, hint: 'a big change' },
			{ value: 'no', label: `Keep ${current}`, hint: 'the car cannot tell the two apart' },
		],
		initialValue: 'patch',
	});
	return part === 'no' ? current : raiseVersion(current, part);
}
