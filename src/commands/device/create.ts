import { join, relative } from 'node:path';
import {
	type AddResult,
	addDeviceToApp,
	type DeviceDefinition,
	definedDevices,
} from '../../core/device/app.ts';
import { cppName, headerPath, readFirmwareSource, readNodes } from '../../core/device/network.ts';
import {
	boardId,
	boards,
	createDevice,
	deviceName,
	devicesFolder,
	listDevices,
} from '../../core/device/project.ts';
import { requireCar } from '../../core/project/find.ts';
import { type NextStep, nextSteps } from '../../ui/next-steps.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { select, text } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { pubPath } from '../../utils/pub-path.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';

/** Internal: the answer for a device that is not in the car's app yet. */
const newDevice = '\0new';

/**
 * Makes the PlatformIO project of one device on the car's CAN bus, for a device the car's
 * app defines, or a new one it puts into the app first.
 */
export const deviceCreateCommand: Command = {
	name: 'create',
	aliases: ['new'],
	summary: 'Make the program of a device on your CAN bus',
	description: `Makes a folder in ${devicesFolder}/ for one of the devices on your car's CAN bus, with its program in src/main.cpp, ready to build for its board. Pick a device your car's app defines, or a new one, which it puts into your car's app for you. Run it in your car's app folder.`,
	usage: '[name]',
	examples: [
		`${binaryName} device create`,
		`${binaryName} device create headlights --board esp32-s3`,
		`${binaryName} device create seatHeater --title "Seat heater" --board esp32-c3`,
	],
	flags: {
		board: {
			type: 'string',
			describe: 'Its board: esp32, esp32-s3, esp32-c3, or any PlatformIO board name',
		},
		title: {
			type: 'string',
			describe: 'For a new device, what the driver reads, like "Seat heater"',
		},
	},
	async run({ flags, positionals }) {
		intro('Make a device');
		const app = await requireCar();
		const state = await readCarStep(app);
		const firmware = await readFirmwareSource(state);

		const known = await knownDevices(app.dir);
		const made = new Set((await listDevices(app.dir)).map((d) => cppName(d.settings.device)));
		const given = positionals[0]?.trim();

		let device: DeviceDefinition;
		let isNew = false;
		const found = given
			? known.find((d) => d.name === given || cppName(d.name) === given)
			: undefined;
		if (found) {
			device = found;
		} else if (given) {
			device = await describeNew(given, flags.title, flags.yes === true, known);
			isNew = true;
		} else {
			const free = known.filter((d) => !made.has(cppName(d.name)));
			const choice =
				free.length === 0
					? newDevice
					: await select<string>({
							message: 'Which device is it for?',
							options: [
								...free.map((d) => ({ value: d.name, label: d.title, hint: `node ${d.node}` })),
								{ value: newDevice, label: 'A new device', hint: "put into your car's app" },
							],
						});
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

		const board = await pickBoard(flags.board);
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

/** Internal: the board, from the flag or by asking. */
async function pickBoard(given: unknown): Promise<string> {
	if (typeof given === 'string' && given.trim()) return boardId(given);
	const other = '\0other';
	const choice = await select<string>({
		message: 'Which board is it?',
		options: [
			...boards.map((board) => ({ value: board.id, label: board.label, hint: board.id })),
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
