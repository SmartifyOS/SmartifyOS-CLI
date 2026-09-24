import { type CarState, describeVersion, readCar } from '../core/project/car.ts';
import type { ChangeFailure, ChangeStep } from '../core/project/change.ts';
import type { CarApp } from '../core/project/find.ts';
import { log } from './output.ts';
import { spinner } from './prompt.ts';
import { theme } from './theme.ts';

/**
 * What the commands that change a car's app have in common on screen.
 */

/** What each step of trying a change is called while it happens. */
export const changeStepText: Record<ChangeStep, string> = {
	fetch: 'Fetching packages',
	check: 'Checking that everything still builds',
	undo: 'It did not fit, putting everything back',
};

/** Follows a change's steps on a spinner. */
export function followSteps(progress: ReturnType<typeof spinner>): (step: ChangeStep) => void {
	return (step) => progress.message(changeStepText[step]);
}

/** How many errors of one package are shown before the rest are counted instead. */
const shownPerPackage = 3;

/**
 * Explains why a change was taken back, naming each package at fault by what a person
 * calls it rather than by a path in the pub cache.
 */
export function renderChangeFailure(
	failure: ChangeFailure,
	titleOf: (packageName: string) => string,
): void {
	if (failure.kind === 'fetch') {
		log.error('These packages do not fit together.', failure);
		log.message(theme.dim(failure.output));
		return;
	}

	for (const group of failure.problems) {
		const who = group.name ? theme.strong(titleOf(group.name)) : 'Your app';
		const lines = group.problems
			.slice(0, shownPerPackage)
			.map((problem) => theme.dim(`${problem.file}:${problem.line}  ${problem.message}`));
		const more = group.problems.length - shownPerPackage;
		if (more > 0) lines.push(theme.dim(`and ${more} more`));
		// Every error goes to a program, not just the first few a person gets to read.
		const data = {
			package: group.name ?? null,
			title: group.name ? titleOf(group.name) : null,
			problems: group.problems,
		};
		log.error([`${who} does not build with this:`, ...lines].join('\n'), data);
	}
}

/**
 * Runs one piece of work under a spinner, which is left on screen as a finished step: with
 * `done` when that says more than `text` does.
 */
export async function step<T>(
	text: string,
	work: () => Promise<T>,
	done?: (value: T) => string,
): Promise<T> {
	const progress = spinner();
	progress.start(text);
	try {
		const value = await work();
		progress.stop(done ? done(value) : text);
		return value;
	} catch (error) {
		progress.error(text);
		throw error;
	}
}

/** Reads the car under a spinner, and says what it runs. */
export async function readCarStep(app: CarApp): Promise<CarState> {
	return await step(
		'Reading your car',
		() => readCar(app),
		(state) => {
			const count = state.extensions.length;
			const extensions =
				count === 0 ? 'no extensions' : count === 1 ? '1 extension' : `${count} extensions`;
			return `Your car runs SmartifyOS ${describeVersion(state.core)}, with ${extensions}`;
		},
	);
}
