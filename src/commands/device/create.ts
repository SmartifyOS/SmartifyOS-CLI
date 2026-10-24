import { join, relative } from 'node:path';
import {
	type AddResult,
	addDeviceToApp,
	type DeviceDefinition,
	definedDevices,
} from '../../core/device/app.ts';
import type { FirmwareSource } from '../../core/device/network.ts';
import { cppName, headerPath, readFirmwareSource, readNodes } from '../../core/device/network.ts';
import {
	arduinoBoard,
	arduinoBoards,
	boardId,
	boards,
	createDevice,
	createUsbDevice,
	deviceName,
	devicesFolder,
	listDevices,
} from '../../core/device/project.ts';
import {
	addSerialDeviceToApp,
	defaultBaudRate,
	definedSerialDevices,
	type SerialAddResult,
	type SerialDeviceDefinition,
	serialFile,
} from '../../core/device/serial-app.ts';
import type { CarApp } from '../../core/project/find.ts';
import { requireCar } from '../../core/project/find.ts';
import { type NextStep, nextSteps } from '../../ui/next-steps.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { isInteractive, select, text } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { pubPath } from '../../utils/pub-path.ts';
import { binaryName } from '../flags.ts';
import type { Command, Flags } from '../types.ts';

/** Internal: the answers for a device that is not in the car's app yet. */
const newDevice = '\0new';
const newUsbDevice = '\0new-usb';
/** Internal: in front of the name of a board on USB, among the answers. */
const usbPrefix = '\0usb:';

/**
 * Makes the PlatformIO project of one device on the car's CAN bus, or of one board on a USB
 * cable (`--usb`), for a device the car's app defines, or a new one it puts into the app
 * first.
 */
export const deviceCreateCommand: Command = {
	name: 'create',
	aliases: ['new'],
	summary: 'Make the program of a device',
	description: `Makes a folder in ${devicesFolder}/ for one of the devices on your car's CAN bus, or a board on a USB cable (--usb), with its program in src/main.cpp, ready to build for its board. Pick a device your car's app defines, or a new one, which it puts into your car's app for you. A board on USB is the simpler way for a car with only one or two: any ESP32, an Arduino Uno or Nano, with no CAN bus. Run it in your car's app folder.`,
	usage: '[name]',
	examples: [
		`${binaryName} device create`,
		`${binaryName} device create headlights --board esp32-s3`,
		`${binaryName} device create seatHeater --title "Seat heater" --board esp32-c3`,
		`${binaryName} device create dashboard --usb --title "Dashboard Arduino" --board uno`,
	],
	flags: {
		board: {
			type: 'string',
			describe:
				'Its board: esp32, esp32-s3, esp32-c3, or any PlatformIO ESP32 name, and for --usb also uno, nano or nano-old',
		},
		title: {
			type: 'string',
			describe: 'For a new device, what the driver reads, like "Seat heater"',
		},
		usb: {
			type: 'boolean',
			describe: 'A board on a USB cable to the car, rather than on the CAN bus',
		},
		'baud-rate': {
			type: 'string',
			describe: `For --usb, how fast it talks, ${defaultBaudRate} unless given`,
		},
	},
	async run({ flags, positionals }) {
		intro('Make a device');
		const app = await requireCar();
		const state = await readCarStep(app);
		const firmware = await readFirmwareSource(state);

		const known = await knownDevices(app.dir);
		const onUsb = await definedSerialDevices(app.dir);
		const made = new Set((await listDevices(app.dir)).map((d) => cppName(d.settings.device)));
		const given = positionals[0]?.trim();
		const usb = { known: onUsb, made, firmware, app };

		let device: DeviceDefinition;
		let isNew = false;
		const found = given
			? known.find((d) => d.name === given || cppName(d.name) === given)
			: undefined;
		const foundOnUsb = given ? onUsb.find((d) => d.name === given) : undefined;
		if (foundOnUsb) {
			return await createOnUsb(usb, flags, foundOnUsb);
		} else if (flags.usb === true && !found) {
			return await createOnUsb(usb, flags, given);
		} else if (found) {
			device = found;
		} else if (given) {
			device = await describeNew(given, flags.title, flags.yes === true, known);
			isNew = true;
		} else {
			const free = known.filter((d) => !made.has(cppName(d.name)));
			const freeOnUsb = onUsb.filter((d) => !made.has(cppName(d.name)));
			const nothingToAsk =
				free.length === 0 && freeOnUsb.length === 0 && (flags.yes === true || !isInteractive());
			const choice = nothingToAsk
				? newDevice
				: await select<string>({
						message: 'Which device is it for?',
						options: [
							...free.map((d) => ({ value: d.name, label: d.title, hint: `node ${d.node}` })),
							...freeOnUsb.map((d) => ({
								value: `${usbPrefix}${d.name}`,
								label: d.title,
								hint: 'on USB',
							})),
							{
								value: newDevice,
								label: 'A new device on the CAN bus',
								hint: "put into your car's app",
							},
							{
								value: newUsbDevice,
								label: 'A new board on a USB cable',
								hint: 'simpler, for a car with only one or two',
							},
						],
					});
			if (choice === newUsbDevice) return await createOnUsb(usb, flags, undefined);
			const pickedOnUsb = onUsb.find((d) => `${usbPrefix}${d.name}` === choice);
			if (pickedOnUsb) return await createOnUsb(usb, flags, pickedOnUsb);
			const picked = known.find((d) => d.name === choice);
			if (picked) device = picked;
			else {
				device = await describeNew(undefined, flags.title, flags.yes === true, known);
				isNew = true;
			}
		}
		if (made.has(cppName(device.name))) {
			throw new CliError(
				`${device.name} has a project already, in ${devicesFolder}/${cppName(device.name)}.`,
				{
					hint: `Build it with ${theme.code(`${binaryName} device flash ${device.name}`)}.`,
				},
			);
		}

		let added: AddResult | undefined;
		if (isNew) {
			added = await step(
				`Putting ${theme.strong(device.title)} into your car's app, as node ${device.node}`,
				() => addDeviceToApp(app.dir, device),
				(result) =>
					result.kind === 'done'
						? `Put ${theme.strong(device.title)} into ${theme.code(result.file)}, as node ${device.node}`
						: `${theme.strong(device.title)} has to go into your car's app by hand`,
			);
			if (added.kind === 'manual') {
				log.warn(
					[
						added.reason === 'no-place'
							? "There is no one clear CanConfig(devices: [...]) in your car's app to put it in. Add this to it yourself:"
							: "Your car's app did not analyze with it, so it was left as it was. Add this to its CanConfig(devices: [...]) yourself:",
						`  ${theme.code(added.dart)}`,
					].join('\n'),
				);
			}
		}

		const board = await pickBoard(flags.board, false);
		const created = await step(
			'Making its project',
			() =>
				createDevice(
					app.dir,
					{ name: cppName(device.name), title: device.title, board, device: device.name },
					firmware,
				),
			(created) => `Made ${theme.code(relative(process.cwd(), created.dir) || '.')}`,
		);

		const folder = relative(process.cwd(), created.dir) || '.';
		const inHeader = (await readNodes(app.dir))?.some((n) => n.name === cppName(device.name));
		const folderInApp = pubPath(app.dir, created.dir);
		const program = `${folderInApp}/src/main.cpp`;
		const steps: NextStep[] = [
			...(isNew
				? [
						{
							kind: 'add-messages',
							text: `Give it the messages it sends, in your car's app. ${theme.dim('DEVICES.md in the SmartifyOS repository shows how.')}`,
						},
					]
				: []),
			...(inHeader
				? []
				: [
						{
							kind: 'run',
							text: `Run ${theme.code(`${binaryName} run`)} once, so SmartifyOS writes ${theme.code(headerPath)} with it in.`,
						},
					]),
			{
				kind: 'write-program',
				text: `Write its program in ${theme.code(join(folder, 'src', 'main.cpp'))}.`,
				path: program,
			},
			{
				kind: 'flash',
				text: `Plug the board in and run ${theme.code(`${binaryName} device flash`)} in ${theme.code(folder)}.`,
				path: folderInApp,
			},
		];
		nextSteps(steps);
		outro('All done.');

		return {
			device: { name: device.name, node: device.node, title: device.title, new: isNew },
			board,
			folder: folderInApp,
			files: created.files,
			app: added
				? added.kind === 'done'
					? { changed: true, file: added.file }
					: { changed: false, dart: added.dart }
				: null,
		};
	},
};

/**
 * Internal: every device the car defines, from the header SmartifyOS wrote, and from the app's
 * Dart for one added since. The Dart has `CanDevice.name` as it is, the header only as C++.
 */
async function knownDevices(appDir: string): Promise<DeviceDefinition[]> {
	const fromDart = await definedDevices(appDir);
	const devices = new Map<string, DeviceDefinition>();
	for (const node of (await readNodes(appDir)) ?? []) {
		const dart = fromDart.find((d) => d.node === node.node && cppName(d.name) === node.name);
		devices.set(node.name, dart ?? { node: node.node, name: node.name, title: node.title });
	}
	for (const dart of fromDart) {
		if (!devices.has(cppName(dart.name))) devices.set(cppName(dart.name), dart);
	}
	return [...devices.values()].sort((a, b) => a.node - b.node);
}

/** Internal: a new device's name, title and the first node number nobody has. */
async function describeNew(
	givenName: string | undefined,
	givenTitle: unknown,
	yes: boolean,
	known: DeviceDefinition[],
): Promise<DeviceDefinition> {
	let title = typeof givenTitle === 'string' ? givenTitle.trim() : '';
	if (!title && givenName && yes) title = givenName;
	if (!title) {
		title = (
			await text({
				message: 'What is the new device called? This is the name the driver reads.',
				placeholder: 'Seat heater',
				...(givenName ? { defaultValue: givenName, initialValue: givenName } : {}),
				validate: (value) => (value?.trim() ? undefined : 'It needs a name.'),
			})
		).trim();
	}
	const name = givenName ?? deviceName(title);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new CliError(`${name} cannot be a device's name.`, {
			hint: 'Letters and digits, starting with a letter, like seatHeater.',
		});
	}
	if (known.some((d) => cppName(d.name) === name)) {
		throw new CliError(`Your car has a device called ${name} already.`, {
			hint: 'Give the new one another name.',
		});
	}

	const taken = new Set(known.map((d) => d.node));
	let node = 1;
	while (taken.has(node)) node++;
	if (node > 127) {
		throw new CliError('Your car has 127 devices already, which is all a CAN bus takes.');
	}
	return { node, name, title };
}

/**
 * Internal: the board, from the flag or by asking. An Arduino only on USB, since it has no
 * CAN.
 */
async function pickBoard(given: unknown, usb: boolean): Promise<string> {
	if (typeof given === 'string' && given.trim()) {
		const id = boardId(given);
		const arduino = arduinoBoard(id);
		if (arduino && !usb) {
			throw new CliError(`An ${arduino.label} has no CAN, so it cannot go on the CAN bus.`, {
				hint: `Plug it in by its USB cable instead, with ${theme.code('--usb')}, or use an ESP32.`,
			});
		}
		return id;
	}
	const other = '\0other';
	const choice = await select<string>({
		message: 'Which board is it?',
		options: [
			...[...boards, ...(usb ? arduinoBoards : [])].map((board) => ({
				value: board.id,
				label: board.label,
				hint: board.id === 'nanoatmega328' ? 'most clones' : board.id,
			})),
			{ value: other, label: 'Another ESP32 board', hint: 'by its PlatformIO name' },
		],
	});
	if (choice !== other) return choice;
	const typed = await text({
		message:
			"What is the board's name in PlatformIO? See https://docs.platformio.org/en/latest/boards/",
		placeholder: 'esp32-s3-devkitm-1',
		validate: (value) => (value?.trim() ? undefined : 'The name is needed.'),
	});
	return boardId(typed);
}

/** Internal: what making a board on USB needs from the command. */
interface UsbContext {
	known: SerialDeviceDefinition[];
	made: Set<string>;
	firmware: FirmwareSource;
	app: CarApp;
}

/**
 * Internal: makes the project of a board on a USB cable: one the car's app defines already,
 * or a new one it puts in first, as a constant in lib/serial.dart and in its SerialConfig.
 */
async function createOnUsb(
	{ known, made, firmware, app }: UsbContext,
	flags: Flags,
	given: SerialDeviceDefinition | string | undefined,
) {
	const existing = typeof given === 'object' ? given : undefined;
	const device = existing ?? (await describeNewUsb(given as string | undefined, flags, known));
	if (made.has(cppName(device.name))) {
		throw new CliError(
			`${device.name} has a project already, in ${devicesFolder}/${cppName(device.name)}.`,
			{
				hint: `Put it on its board with ${theme.code(`${binaryName} device flash ${device.name}`)}.`,
			},
		);
	}

	let added: SerialAddResult | undefined;
	if (!existing) {
		added = await step(
			`Putting ${theme.strong(device.title)} into your car's app`,
			() => addSerialDeviceToApp(app.dir, device),
			(result) =>
				result.kind === 'done'
					? `Put ${theme.strong(device.title)} into ${theme.code(serialFile)}`
					: `${theme.strong(device.title)} has to go into your car's app by hand`,
		);
		if (added.kind === 'manual') {
			log.warn(
				[
					added.reason === 'no-place'
						? "There is no one clear place in your car's app to put it. Add this to lib/serial.dart, and the serial line to SmartifyOs().init in lib/main.dart, yourself:"
						: "Your car's app did not analyze with it, so it was left as it was. Add this yourself:",
					theme.code(added.dart),
				].join('\n'),
			);
		}
	}

	const board = await pickBoard(flags.board, true);
	const name = cppName(device.name);
	const created = await step(
		'Making its project',
		() =>
			createUsbDevice(
				app.dir,
				{ name, title: device.title, board, device: device.name, baudRate: device.baudRate },
				firmware,
			),
		(created) => `Made ${theme.code(relative(process.cwd(), created.dir) || '.')}`,
	);

	const folder = relative(process.cwd(), created.dir) || '.';
	const folderInApp = pubPath(app.dir, created.dir);
	const where = existing?.file ?? serialFile.split('\\').join('/');
	nextSteps([
		{
			kind: 'write-program',
			text: `Write its program in ${theme.code(join(folder, 'src', 'main.cpp'))}.`,
			path: `${folderInApp}/src/main.cpp`,
		},
		{
			kind: 'flash',
			text: `Plug the board in and run ${theme.code(`${binaryName} device flash`)} in ${theme.code(folder)}.`,
			path: folderInApp,
		},
		{
			kind: 'read-serial',
			text: `Read what it prints in your car's app, with ${theme.code(`SmartifyOsSerial.values(${device.name}, 'oil')`)}. ${theme.dim('DEVICES.md in the SmartifyOS repository shows how.')}`,
			path: where,
		},
	]);
	outro('All done.');

	return {
		device: {
			name: device.name,
			node: null,
			title: device.title,
			new: !existing,
			connection: 'usb',
			baudRate: device.baudRate,
		},
		board,
		folder: folderInApp,
		files: created.files,
		app: added
			? added.kind === 'done'
				? { changed: true, files: added.files }
				: { changed: false, dart: added.dart }
			: null,
	};
}

/** Internal: a new board's name, title and speed. */
async function describeNewUsb(
	givenName: string | undefined,
	flags: Flags,
	known: SerialDeviceDefinition[],
): Promise<{ name: string; title: string; baudRate: number }> {
	const yes = flags.yes === true;
	let title = typeof flags.title === 'string' ? flags.title.trim() : '';
	if (!title && givenName && yes) title = givenName;
	if (!title) {
		title = (
			await text({
				message: 'What is the new board called? This is the name the driver reads.',
				placeholder: 'Dashboard Arduino',
				...(givenName ? { defaultValue: givenName, initialValue: givenName } : {}),
				validate: (value) => (value?.trim() ? undefined : 'It needs a name.'),
			})
		).trim();
	}
	const name = givenName ?? deviceName(title);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new CliError(`${name} cannot be a board's name.`, {
			hint: 'Letters and digits, starting with a letter, like dashboard.',
		});
	}
	if (known.some((d) => d.name === name)) {
		throw new CliError(`Your car has a board called ${name} already.`, {
			hint: 'Give the new one another name.',
		});
	}
	const baudRate = parseBaudRate(flags['baud-rate']) ?? defaultBaudRate;
	return { name, title, baudRate };
}

/**
 * Internal: `--baud-rate` as a number, undefined when it is not given.
 *
 * @throws {CliError} when it is not a speed a board talks at.
 */
export function parseBaudRate(given: unknown): number | undefined {
	if (given === undefined || given === '') return undefined;
	const number = Number(given);
	if (!Number.isInteger(number) || number < 300 || number > 2_000_000) {
		throw new CliError(`${String(given)} is not a speed a board talks at.`, {
			hint: `The same number as Serial.begin in its sketch, like 9600 or ${defaultBaudRate}.`,
		});
	}
	return number;
}
