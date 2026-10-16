import { type Check, runChecks } from '../core/setup/doctor.ts';
import { CliError } from '../utils/errors.ts';
import { log } from './output.ts';
import { step } from './project.ts';
import { theme } from './theme.ts';

/** What `doctor` and `setup` say about this computer, as data. */
export interface DoctorReport {
	/** No check failed, so SmartifyOS can make a car here. Warnings do not count. */
	ready: boolean;
	errors: number;
	warnings: number;
	checks: Check[];
}

export function doctorReport(checks: Check[]): DoctorReport {
	const errors = checks.filter((check) => check.status === 'error').length;
	const warnings = checks.filter((check) => check.status === 'warning').length;
	return { ready: errors === 0, errors, warnings, checks };
}

/** Prints every check as a line of its own, with what it is for and what to do under it. */
export function renderChecks(checks: Check[]): void {
	for (const check of checks) {
		const lines = [`${theme.strong(check.title)}  ${check.summary}`];
		if (check.status !== 'ok' && check.neededFor) lines.push(theme.dim(check.neededFor));
		if (check.hint) lines.push(theme.dim(check.hint));
		const text = lines.join('\n');
		if (check.status === 'ok') log.success(text, check);
		else if (check.status === 'warning') log.warn(text, check);
		else log.error(text, check);
	}
}

/**
 * Checks this computer under a spinner and prints what it found.
 *
 * @throws {CliError} when anything SmartifyOS cannot work without is missing, with the
 * report as its details.
 */
export async function checkComputer(): Promise<DoctorReport> {
	const checks = await step('Checking this computer', runChecks, () => 'Checked this computer');
	renderChecks(checks);
	const report = doctorReport(checks);
	if (report.errors > 0) {
		throw new CliError('SmartifyOS cannot make a car on this computer yet.', {
			hint: 'Fix what is marked as an error above. smartify-os setup installs Flutter for you.',
			details: report,
		});
	}
	return report;
}

/** The closing line for a computer that is ready, warnings or not. */
export function readySummary(report: DoctorReport): string {
	if (report.warnings === 0) return theme.success('Everything is ready.');
	const which = report.warnings === 1 ? 'The warning is' : 'The warnings are';
	return `Ready to make a car. ${theme.dim(`${which} only about what some setups need.`)}`;
}
