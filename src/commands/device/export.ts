import type { BuiltFirmware } from '../../core/device/build.ts';
import { readFirmwareSource } from '../../core/device/network.ts';
import type { DeviceProject } from '../../core/device/project.ts';
import { writeDeviceFirmware } from '../../core/device/stick.ts';
import { readExistingExport } from '../../core/export/export.ts';
import { requireCar } from '../../core/project/find.ts';
import { intro, log, outro } from '../../ui/output.ts';
import { readCarStep, step } from '../../ui/project.ts';
import { isInteractive, multiselect, note } from '../../ui/prompt.ts';
import { theme } from '../../ui/theme.ts';
import { pickTarget } from '../export/shared.ts';
import { binaryName } from '../flags.ts';
import type { Command } from '../types.ts';
import { buildAtVersion, deviceData, ensurePlatformio, findDevices, raiseFlag } from './shared.ts';

/**
 * Builds the firmware of the car's devices onto a USB stick, into the same `smartify-os`
 * folder `export update` uses, alone or next to an update. The driver then updates each
 * device in the car, over the bus.
 */
export const deviceExportCommand: Command = {
	name: 'export',
	summary: 'Put new firmware for your devices on a USB stick',
	description:
		"Builds the program of the devices on your car's CAN bus you pick (all of them, unless you name some) and puts it on a USB stick, next to an update of your car's app if there is one on it. Plug the stick into the car, open Settings, Vehicle, Devices in the car, and update each device there. Run it in your car's app folder.",
	usage: '[device...]',
	examples: [
		`${binaryName} device export`,
		`${binaryName} device export headlights buttons --to /Volumes/USB`,
	],
	flags: {
		to: {
			type: 'string',
			describe: 'The USB stick to put it on, or any folder to copy onto one later',
		},
		...raiseFlag,
	},
	async run({ flags, positionals }) {
		intro('Put firmware on a USB stick');
		const app = await requireCar();
		const state = await readCarStep(app);
		const firmware = await readFirmwareSource(state);
		const devices = await pickDevices(app.dir, positionals, flags.yes === true);

		const target = await pickTarget(flags.to);
		const existing = await readExistingExport(target);
		if (existing?.kind === 'update') {
			log.info(
				`It goes next to the update${existing.app ? ` for ${existing.app}` : ''} on the stick.`,
			);
		}

		await ensurePlatformio();
		const builds: { device: DeviceProject; built: BuiltFirmware; raised: boolean }[] = [];
		for (const device of devices) {
			builds.push({ device, ...(await buildAtVersion(device, app.dir, firmware, flags)) });
		}

		const written = await step(
			'Putting the firmware on it',
			() =>
				writeDeviceFirmware(
					target,
					builds.map(({ device, built }) => ({ device: device.settings.device, built })),
				),
			(written) => `Written to ${theme.code(written.folder)}`,
		);

		note(
			[
				'1. Plug the stick into the car while SmartifyOS runs.',
				'2. Open Settings, Vehicle, Devices in the car, and pick the device.',
				'3. Tap Update. It takes about a minute, and the device keeps working meanwhile.',
			].join('\n'),
			'In the car',
		);
		outro('All done.');

		return {
			folder: written.folder,
			files: written.files,
			devices: builds.map(({ device, built, raised }) => ({
				...deviceData(device, app.dir),
				raised,
				chip: built.chip ?? null,
				size: built.size,
				sha256: built.sha256,
			})),
		};
	},
};

/** Internal: the devices named, or else all of them, picked from when somebody can. */
async function pickDevices(
	appDir: string,
	given: string[],
	yes: boolean,
): Promise<DeviceProject[]> {
	const { all, named } = await findDevices(appDir, given);
	if (named.length > 0) return [...new Set(named)];
	if (all.length === 1 || yes || !isInteractive()) return all;
	const picked = await multiselect<string>({
		message: 'Which devices should get new firmware?',
		options: all.map((device) => ({
			value: device.dir,
			label: device.settings.device,
			hint: device.settings.version,
		})),
		initialValues: all.map((device) => device.dir),
	});
	return all.filter((device) => picked.includes(device.dir));
}
