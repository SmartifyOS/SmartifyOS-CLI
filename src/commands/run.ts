import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AndroidDevice, androidDevices, hasAdb } from '../core/android/sdk.ts';
import { headerPath } from '../core/device/network.ts';
import { addPlatforms, desktopPlatform } from '../core/flutter.ts';
import { requireCar } from '../core/project/find.ts';
import { AppCallError, VmService, vmServiceAddress } from '../core/vm-service.ts';
import { prepareAndroid } from '../ui/android.ts';
import { runAttached } from '../ui/attached.ts';
import { takeCalls } from '../ui/json.ts';
import { intro, log } from '../ui/output.ts';
import { readCarStep, step } from '../ui/project.ts';
import { select } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command, Flags } from './types.ts';

/**
 * Runs the car's app on this computer, as a debug build started from the app's folder.
 *
 * That is also what makes SmartifyOS write the header the firmware of the car's devices is
 * built against (`CanFirmwareHeader.writeIfDeveloping` in core), which it only does with a
 * `pubspec.yaml` in the folder it was started from.
 */
export const runCommand: Command = {
	name: 'run',
	summary: "Try your car's app on this computer",
	description: `Starts your car's app on this computer, or with --android on an Android tablet or phone plugged into it. Save a change and press r in the terminal to see it straight away, q to stop. While it runs, SmartifyOS writes ${headerPath} for the devices on your car's CAN bus. Run it in your car's app folder.`,
	examples: [`${binaryName} run`, `${binaryName} run --android`],
	flags: {
		android: {
			type: 'boolean',
			describe: 'Run it on an Android device plugged into this computer instead',
		},
		device: {
			type: 'string',
			describe: 'Which Android device, by its id, when more than one is plugged in',
		},
	},
	async run({ flags }) {
		const app = await requireCar();
		const onAndroid = flags.android === true || typeof flags.device === 'string';
		const platform = onAndroid ? 'android' : desktopPlatform();
		intro("Run your car's app");
		const state = await readCarStep(app);

		let device: AndroidDevice | undefined;
		if (onAndroid) {
			await prepareAndroid(state, flags.yes === true);
			device = await pickDevice(flags);
		} else if (!existsSync(join(app.dir, platform))) {
			const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'app';
			await step(
				`Your car's app has no ${platform} part yet, adding it to run it here`,
				() => addPlatforms(app.dir, [platform], name),
				() => `Added the ${platform} part to your car's app`,
			);
		}

		log.info(
			`Starting it${device ? ` on ${theme.strong(device.name)}` : ''}. Press ${theme.code('r')} to see a change, ${theme.code('q')} to stop.${device ? theme.dim(' The first build for Android can take ten minutes or more.') : ''}`,
		);
		// Under --json, `{"call": ...}` reaches the app through its VM service, once Flutter
		// has said where that is.
		let service: VmService | undefined;
		const stopCalls = takeCalls(async (call, params) => {
			if (!service) throw new AppCallError("Your car's app is not running yet.");
			return await service.callExtension(call, params);
		});
		const onLine = (line: string) => {
			const address = vmServiceAddress(line);
			if (!address) return;
			service?.close();
			service = new VmService(address);
		};
		let code: number;
		try {
			// From the app's own folder, which is where SmartifyOS writes the firmware header.
			code = await runAttached('flutter', ['run', '-d', device?.id ?? platform], app.dir, {
				onLine,
			});
		} finally {
			stopCalls();
			service?.close();
		}
		if (code !== 0) {
			throw new CliError("Your car's app stopped with an error.", {
				hint: 'What Flutter printed above says why.',
			});
		}
		return {
			platform,
			device: device ?? null,
			header: existsSync(join(app.dir, headerPath)) ? headerPath : null,
		};
	},
};

/** Internal: the Android device to run on, by the flag, the only one, or by asking. */
async function pickDevice(flags: Flags): Promise<AndroidDevice> {
	const devices = await step(
		'Looking for Android devices',
		() => androidDevices(),
		(found) =>
			found.length === 1
				? `Found ${found[0]?.name}`
				: `Found ${found.length === 0 ? 'no' : found.length} Android devices`,
	);
	const given = typeof flags.device === 'string' ? flags.device.trim() : undefined;
	if (given) {
		const found = devices.find((d) => d.id === given || d.name === given);
		if (found) return found;
		throw new CliError(`There is no Android device ${given} plugged in.`, {
			hint: devices.length
				? `These are: ${devices.map((d) => `${d.name} (${d.id})`).join(', ')}.`
				: 'Plug it in with a USB cable, with USB debugging switched on in its developer options.',
		});
	}
	const [only] = devices;
	if (devices.length === 1 && only) return only;
	if (devices.length === 0) {
		throw new CliError('No Android device is plugged into this computer.', {
			hint: (await hasAdb())
				? 'Plug it in with a USB cable and switch USB debugging on in its developer options (tap the build number in About seven times to show them). Then say yes to this computer on its screen.'
				: `Running on Android needs the Android SDK. Run ${binaryName} setup --android, then plug the device in with USB debugging on.`,
		});
	}
	return await select<AndroidDevice>({
		message: 'Which Android device should it run on?',
		options: devices.map((d) => ({
			value: d,
			label: d.name,
			hint: d.emulator ? `an emulator, ${d.sdk}` : d.sdk,
		})),
	});
}
