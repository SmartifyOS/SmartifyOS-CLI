import { binaryName } from '../commands/flags.ts';
import type { NeedProblem } from '../core/linux/collect.ts';
import type { ListProblem } from '../core/linux/lists.ts';
import type { PackageSet } from '../core/linux/set.ts';
import { log } from './output.ts';
import { theme } from './theme.ts';

/**
 * What the commands say about the Linux packages a car needs.
 */

/**
 * Warns about every problem in the lists, once per package for what this CLI does not know
 * yet. Nothing here stops anything: the entry is left out and the rest still goes in.
 */
export function renderNeedProblems(problems: NeedProblem[]): void {
	const unknown = new Map<string, NeedProblem[]>();
	for (const problem of problems) {
		if (problem.kind === 'unknown') {
			unknown.set(problem.requester.title, [
				...(unknown.get(problem.requester.title) ?? []),
				problem,
			]);
			continue;
		}
		log.warn(
			`${theme.strong(problem.requester.title)} lists something for Linux that cannot be installed, so it is left out. ${problem.message} ${theme.dim('Tell its author.')}`,
			problem,
		);
	}
	for (const [title, list] of unknown) {
		log.warn(
			`${theme.strong(title)} needs something this smartify-os does not know how to set up (${list.map((p) => p.path).join(', ')}). Run ${theme.code(`${binaryName} self-update`)}, then this again.`,
			list,
		);
	}
}

/** The lines explaining what is wrong with one package's lists, for an error. */
export function listProblemLines(problems: ListProblem[]): string[] {
	return problems.map((problem) => theme.dim(`${problem.path}: ${problem.message}`));
}

/** How many of something, in words: `1 package`, `3 packages`. */
function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** One sentence saying what the sets hold, for a finished step. */
export function describeSets(sets: PackageSet[]): string {
	const run = sets.find((set) => set.name === 'smartify-os-run');
	const build = sets.find((set) => set.name === 'smartify-os-build');
	const parts = [
		run ? `${count(run.apt.length, 'package', 'packages')} to run` : '',
		build ? `${build.apt.length} to build` : '',
		run?.udev.length ? count(run.udev.length, 'udev rule', 'udev rules') : '',
		run?.groups.length ? count(run.groups.length, 'group', 'groups') : '',
	].filter(Boolean);
	return `The car gets ${parts.join(', ')}`;
}

/** A set as plain data, the way `--json` reports it. */
export function setData(set: PackageSet) {
	return {
		name: set.name,
		apt: set.apt.map((need) => ({
			package: need.package,
			arch: need.arch,
			requesters: need.requesters.map((r) => r.name),
		})),
		udev: set.udev.map((rule) => ({ name: rule.name, requester: rule.requester.name })),
		groups: set.groups.map((need) => ({
			group: need.group,
			requesters: need.requesters.map((r) => r.name),
		})),
	};
}
