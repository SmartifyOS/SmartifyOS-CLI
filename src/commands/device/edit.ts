import { isUsbDevice, listDevices, setSketchBaudRate } from '../../core/device/project.ts';
import { changeSerialDevice, definedSerialDevices } from '../../core/device/serial-app.ts';
import { requireCar } from '../../core/project/find.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { theme } from '../../ui/theme.ts';
import { CliError } from '../../utils/errors.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { parseBaudRate } from './create.ts';

/**
 * Changes a board on a USB cable where the car's app defines it (its `SerialDevice`), and
 * the speed in its sketch with it, so the two stay the same. Which port it is on is never a
 * setting: the car finds it by itself.
 */
export const deviceEditCommand: Command = {
	name: 'edit',
	summary: 'Change what a board on USB is called, or how fast it talks',
	description:
		"Changes what the driver reads for a board on a USB cable (--title), or the speed it talks at (--baud-rate), in your car's app, and the speed in its sketch too when it has one. Run it in your car's app folder.",
	usage: '<name>',
	examples: [
		`${binaryName} device edit dashboard --title "Dashboard Arduino"`,
		`${binaryName} device edit dashboard --baud-rate 9600`,
	],
	flags: {
		title: { type: 'string', describe: 'What the driver reads, like "Dashboard Arduino"' },
		'baud-rate': {
			type: 'string',
			describe: 'How fast it talks, the same as Serial.begin in its sketch',
		},
	},
	async run({ flags, positionals }) {
		intro('Change a board');
		const app = await requireCar();
		const name = positionals[0]?.trim();
		if (!name) {
			throw new CliError('Name the board to change.', {
				hint: theme.code(`${binaryName} device edit dashboard --title "Dashboard Arduino"`),
			});
		}
		const title = typeof flags.title === 'string' ? flags.title.trim() : undefined;
		if (title === '') throw new CliError('The title cannot be empty.');
		const baudRate = parseBaudRate(flags['baud-rate']);
		if (title === undefined && baudRate === undefined) {
			throw new CliError('There is nothing to change.', {
				hint: `Pass ${theme.code('--title')} or ${theme.code('--baud-rate')}.`,
			});
		}

		const known = await definedSerialDevices(app.dir);
		const device = known.find((found) => found.name === name);
		if (!device) {
			throw new CliError(`Your car's app has no board on USB called ${name}.`, {
				hint:
					known.length > 0
						? `It has ${known.map((found) => theme.strong(found.name)).join(', ')}.`
						: `Make one with ${theme.code(`${binaryName} device create --usb`)}.`,
			});
		}
		const changed = await changeSerialDevice(app.dir, name, {
			...(title !== undefined ? { title } : {}),
			...(baudRate !== undefined ? { baudRate } : {}),
		});
		if (!changed) {
			throw new CliError(`${name} could not be changed where it is written.`, {
				hint: `Change it yourself in ${device.file}, line ${device.line}.`,
			});
		}
		log.success(`Changed ${theme.strong(changed.title)} in ${theme.code(changed.file)}`);

		let sketch: 'changed' | 'by-hand' | 'none' = 'none';
		if (baudRate !== undefined) {
			const project = (await listDevices(app.dir)).find(
				(found) => found.settings.device === name && isUsbDevice(found),
			);
			if (project) {
				sketch = (await setSketchBaudRate(project.dir, baudRate)) ? 'changed' : 'by-hand';
				if (sketch === 'changed') log.success(`Its sketch talks at ${baudRate} too`);
				else {
					log.warn(
						`Change Serial.begin in its sketch to ${baudRate} yourself, and put it on the board again.`,
					);
				}
			}
		}
		outro(
			sketch === 'changed'
				? `All done. ${theme.dim(`Put it on the board again with ${binaryName} device flash ${name}.`)}`
				: 'All done.',
		);
		return { device: changed, sketch };
	},
};
