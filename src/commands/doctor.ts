import { checkComputer, readySummary } from '../ui/doctor.ts';
import { intro, outro } from '../ui/output.ts';
import { binaryName } from './flags.ts';
import type { Command } from './types.ts';

/**
 * Says what this computer has for making a car and what is missing, the way `flutter doctor`
 * does, so nobody has to find out halfway through a command.
 */
export const doctorCommand: Command = {
	name: 'doctor',
	summary: 'Check this computer has what SmartifyOS needs',
	description: `Checks Flutter, git, what trying your car's app on this computer needs, PlatformIO and the Android platform tools, and says what to do about anything missing. SmartifyOS does nothing without Flutter and git, so those fail the check. The rest is only needed for some setups, so a missing one is a warning. ${binaryName} setup installs Flutter for you.`,
	examples: [`${binaryName} doctor`],
	utility: true,
	async run() {
		intro('Doctor');
		const report = await checkComputer();
		outro(readySummary(report));
		return report;
	},
};
