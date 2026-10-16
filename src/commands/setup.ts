import { isPlatformioReady, platformioRunsHere } from '../core/device/platformio.ts';
import { type FlutterSetUp, type FlutterSetUpStep, setUpFlutter } from '../core/setup/flutter.ts';
import { checkComputer, readySummary } from '../ui/doctor.ts';
import { nextSteps } from '../ui/next-steps.ts';
import { intro, outro } from '../ui/output.ts';
import { confirm, isInteractive, spinner } from '../ui/prompt.ts';
import { theme } from '../ui/theme.ts';
import { ensurePlatformio } from './device/shared.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/**
 * Gets a computer ready to make a car, which is the first thing anyone runs after installing
 * the CLI: Flutter, unless it has one, PlatformIO when asked, and then what `doctor` says.
 */
export const setupCommand: Command = {
	name: 'setup',
	summary: 'Get this computer ready to make a car',
	description: `Installs Flutter, which SmartifyOS is built with, unless this computer has it already. It goes into ~/.smartify-os/tools, out of your way, and is only used when there is no other Flutter. With --platformio it also sets up PlatformIO, which builds the devices on your car's CAN bus. Then it checks everything else the way ${binaryName} doctor does. Run it once after installing, and again any time.`,
	examples: [`${binaryName} setup`, `${binaryName} setup --platformio`],
	flags: {
		platformio: {
			type: 'boolean',
			describe: "Also set up PlatformIO, for the devices on your car's CAN bus",
		},
	},
	async run({ flags }) {
		intro('Set up this computer');
		const flutter = await flutterStep();

		let platformio = false;
		if (!(await isPlatformioReady()) && (await wantsPlatformio(flags.platformio, flags.yes))) {
			await ensurePlatformio();
			platformio = true;
		}

		const report = await checkComputer();
		nextSteps([
			{ kind: 'create', text: `Run ${theme.code(`${binaryName} create`)} to start your car.` },
		]);
		outro(report.warnings === 0 ? 'This computer is ready.' : readySummary(report));
		return {
			flutter: {
				installed: flutter.installed,
				version: flutter.version.version,
				channel: flutter.version.channel,
				path: flutter.path,
			},
			platformio: { installed: platformio },
			doctor: report,
		};
	},
};

/** Internal: what is on screen while each part of installing Flutter happens. */
function flutterStepText(step: FlutterSetUpStep, version = ''): string {
	if (step === 'find') return 'Finding the newest Flutter';
	if (step === 'download') return `Downloading Flutter ${version} (this takes a few minutes)`;
	return `Setting up Flutter ${version} for this computer`;
}

/** Internal: installs Flutter under a spinner, or says it is there already. */
async function flutterStep(): Promise<FlutterSetUp> {
	const progress = spinner();
	progress.start('Looking for Flutter');
	try {
		const flutter = await setUpFlutter((step, version) =>
			progress.message(flutterStepText(step, version)),
		);
		const version = theme.strong(flutter.version.version);
		progress.stop(
			flutter.installed
				? `Installed Flutter ${version}`
				: `Flutter ${version} is installed already`,
		);
		return flutter;
	} catch (error) {
		progress.error('Flutter could not be set up');
		throw error;
	}
}

/**
 * Internal: whether to set up PlatformIO. Only some cars have devices on their bus, so it is
 * asked rather than done, and left for later when nobody is there to ask.
 */
async function wantsPlatformio(flag: unknown, yes: unknown): Promise<boolean> {
	if (flag === true) return true;
	if (yes === true || !isInteractive() || !platformioRunsHere()) return false;
	return await confirm({
		message: "Set up PlatformIO too? It builds the devices on your car's CAN bus, if it has any.",
		initialValue: false,
	});
}
