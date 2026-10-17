import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { headerPath } from '../core/device/network.ts';
import { addPlatforms, desktopPlatform } from '../core/flutter.ts';
import { requireCar } from '../core/project/find.ts';
import { AppCallError, VmService, vmServiceAddress } from '../core/vm-service.ts';
import { runAttached } from '../ui/attached.ts';
import { takeCalls } from '../ui/json.ts';
import { intro, log } from '../ui/output.ts';
import { readCarStep, step } from '../ui/project.ts';
import { theme } from '../ui/theme.ts';
import { CliError } from '../utils/errors.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

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
	description: `Starts your car's app on this computer. Save a change and press r in the terminal to see it straight away, q to stop. While it runs, SmartifyOS writes ${headerPath} for the devices on your car's CAN bus. Run it in your car's app folder.`,
	examples: [`${binaryName} run`],
	async run() {
		const app = await requireCar();
		const platform = desktopPlatform();
		intro("Run your car's app");
		const state = await readCarStep(app);

		if (!existsSync(join(app.dir, platform))) {
			const name = /^name:\s*(\S+)/m.exec(state.pubspecText)?.[1] ?? 'app';
			await step(
				`Your car's app has no ${platform} part yet, adding it to run it here`,
				() => addPlatforms(app.dir, [platform], name),
				() => `Added the ${platform} part to your car's app`,
			);
		}

		log.info(`Starting it. Press ${theme.code('r')} to see a change, ${theme.code('q')} to stop.`);
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
			code = await runAttached('flutter', ['run', '-d', platform], app.dir, { onLine });
		} finally {
			stopCalls();
			service?.close();
		}
		if (code !== 0) {
			throw new CliError("Your car's app stopped with an error.", {
				hint: 'What Flutter printed above says why.',
			});
		}
		return { platform, header: existsSync(join(app.dir, headerPath)) ? headerPath : null };
	},
};
