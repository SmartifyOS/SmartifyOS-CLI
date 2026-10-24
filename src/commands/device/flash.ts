import { buildEnv, flashDevice } from '../../core/device/build.ts';
import { readFirmwareSource } from '../../core/device/network.ts';
import { listPorts } from '../../core/device/platformio.ts';
import { type DeviceProject, iniValue, isUsbDevice } from '../../core/device/project.ts';
import { requireCar } from '../../core/project/find.ts';
import { runAttached } from '../../ui/attached.ts';
import { isJsonMode } from '../../ui/json.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { select } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command, Flags } from '../types.ts';
import { buildAtVersion, deviceData, ensurePlatformio, findDevices, raiseFlag } from './shared.ts';

/** The baud rate the library's devices print at. */
const monitorBaud = 115200;

/**
 * Builds a device's firmware and puts it on its board over USB, which is how a new board gets
 * its first firmware: it only has its USB bootloader, and only firmware using the library can
 * be updated over the bus. A board on a USB cable (`connection: 'usb'`) only ever gets it
 * this way.
 */
export const deviceFlashCommand: Command = {
	name: 'flash',
	aliases: ['upload'],
	summary: 'Put a device on its board over USB',
	description:
		"Builds the program of a device and puts it on its board, plugged into this computer with a USB cable. A new board on the CAN bus has to get its first program this way, after that it can be updated in the car too; a board on USB always gets it this way. Quit your car's app on this computer first if it uses the board. Run it in the device's folder, or name the device.",
	usage: '[device]',
	examples: [
		`${binaryName} device flash`,
		`${binaryName} device flash headlights --monitor`,
		`${binaryName} device flash headlights --port /dev/ttyUSB0 --raise no`,
	],
	flags: {
		port: { type: 'string', describe: 'The USB port the board is on, when it cannot be told' },
		monitor: { type: 'boolean', describe: 'Show what the device prints afterwards' },
		...raiseFlag,
	},
	async run({ flags, positionals }) {
		if (flags.monitor === true && isJsonMode()) {
			throw new CliError(
				'--monitor shows what the device prints in a terminal, and --json has none.',
				{
					hint: 'Leave --monitor out.',
				},
			);
		}
		intro('Put a device on its board');
		const app = await requireCar();
		const state = await readCarStep(app);
		const firmware = await readFirmwareSource(state);
		const device = await pickDevice(app.dir, positionals[0]);
		const name = theme.strong(device.settings.device);

		await ensurePlatformio();
		const { built, raised } = await buildAtVersion(device, app.dir, firmware, flags);
		const port = await pickPort(flags);
		const usb = isUsbDevice(device);
		const what = usb ? name : `${name} ${built.version}`;
		await step(
			`Putting ${what} on the board at ${theme.code(port)}`,
			() => flashDevice(device, built.version, port),
			() => `Put ${what} on the board at ${theme.code(port)}`,
		);

		if (flags.monitor === true) {
			const baud = usb ? await sketchBaud(device) : monitorBaud;
			log.info(`What it prints, at ${baud} baud. Press Ctrl+C to stop.`);
			await runAttached(
				'pio',
				['device', 'monitor', '--port', port, '--baud', String(baud)],
				device.dir,
				{ stopsWithCtrlC: true, env: buildEnv(built.version) },
			);
		}
		outro(
			flags.monitor === true
				? 'All done.'
				: `All done. ${theme.dim(`Add --monitor to see what it prints.`)}`,
		);

		return {
			device: deviceData(device, app.dir),
			version: built.version,
			raised,
			port,
			chip: built.chip ?? null,
			size: built.size,
		};
	},
};

/** Internal: the device named, or the one whose folder this is, or the only one, or asked. */
async function pickDevice(appDir: string, given: string | undefined): Promise<DeviceProject> {
	const { all, named, here } = await findDevices(appDir, given ? [given] : []);
	const only = all.length === 1 ? all[0] : undefined;
	const found = named[0] ?? here ?? only;
	if (found) return found;
	const choice = await select<string>({
		message: 'Which device should go on the board?',
		options: all.map((device) => ({
			value: device.dir,
			label: device.settings.device,
			hint: device.settings.version,
		})),
	});
	return all.find((device) => device.dir === choice) ?? (all[0] as DeviceProject);
}

/** Internal: the speed a board on USB talks at, the monitor's in its platformio.ini. */
async function sketchBaud(device: DeviceProject): Promise<number> {
	const ini = await Bun.file(`${device.dir}/platformio.ini`).text();
	return Number(iniValue(ini, 'monitor_speed')) || monitorBaud;
}

/**
 * Internal: the port the board is on, from the flag, or the one board plugged in, or asked
 * when there are several.
 */
async function pickPort(flags: Flags): Promise<string> {
	if (typeof flags.port === 'string' && flags.port.trim()) return flags.port.trim();
	const { usb, boards } = await step(
		'Looking for the board',
		() => listPorts(),
		(found) =>
			found.boards.length === 1
				? `Found the board at ${theme.code(found.boards[0]?.port ?? '')}`
				: found.boards.length === 0
					? 'Found no board'
					: `Found ${found.boards.length} boards`,
	);
	const board = boards.length === 1 ? boards[0] : undefined;
	if (board) return board.port;

	if (usb.length === 0) {
		throw new CliError('There is no board plugged into this computer.', {
			hint: `Plug it in with a USB cable that carries data, not one only for charging, or pass its port with ${theme.code('--port')}.`,
		});
	}
	const candidates = boards.length > 0 ? boards : usb;
	return await select<string>({
		message:
			boards.length > 0
				? 'There is more than one board plugged in. Which one should it go on?'
				: 'None of the USB ports looks like a board. Which one is it on?',
		options: candidates.map((port) => ({
			value: port.port,
			label: port.port,
			...(port.description && port.description !== 'n/a' ? { hint: port.description } : {}),
		})),
	});
}
