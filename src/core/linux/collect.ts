import { join } from 'node:path';
import { titleOf } from '../project/car.ts';
import { parsePubspec, readPackageRoots } from '../pubspec/read.ts';
import { corePackage } from '../smartify-os.ts';
import type { LinuxArch } from './distro.ts';
import {
	type AptEntry,
	checkUdevRule,
	installedRuleName,
	type ListProblem,
	type PackageLists,
	parseLists,
} from './lists.ts';

/**
 * Everything a car's app needs installed on Linux, gathered from every package it resolved.
 *
 * Every package in `package_config.json` is read, not just SmartifyOS and the extensions:
 * a library an extension depends on can list something, and so can the car's app itself.
 * The folder pub resolved is exactly the version the car runs, and for a linked extension
 * it is the folder on this computer, which is right while someone works on one.
 */

/** A package that asked for something, by name and by what a person calls it. */
export interface Requester {
	name: string;
	title: string;
}

/** One package to install with apt, and every package that asked for it. */
export interface AptNeed {
	package: string;
	/** Only on these architectures, null for every one. */
	arch: LinuxArch[] | null;
	requesters: Requester[];
}

/** One udev rule file to install. */
export interface UdevNeed {
	/** The name it is installed under, see {@link installedRuleName}. */
	name: string;
	/** Its contents. */
	text: string;
	requester: Requester;
}

/** One group the car's user is added to. */
export interface GroupNeed {
	group: string;
	requesters: Requester[];
}

/** A problem in one package's lists. The entry it is about is left out. */
export interface NeedProblem extends ListProblem {
	requester: Requester;
}

/** Everything the car needs, merged, with who asked for each. */
export interface CarNeeds {
	/** Needed to build the car's app. */
	build: AptNeed[];
	/** Loaded or started while it runs, which the build cannot show. */
	run: AptNeed[];
	udev: UdevNeed[];
	groups: GroupNeed[];
	problems: NeedProblem[];
}

/** What the car's app itself is called when it asks for something. */
export const appTitle = "Your car's app";

/**
 * Reads the lists of every package the car's app resolved. Pub has to have run, see
 * `ensureResolved`.
 */
export async function collectNeeds(appDir: string): Promise<CarNeeds> {
	const roots = await readPackageRoots(appDir);
	const found: PackageFound[] = [];

	for (const [name, root] of [...roots].sort(byRequesterOrder(appDir))) {
		const read = await readPackageLists(root);
		if (!read) continue;
		const title =
			root === appDir ? appTitle : name === corePackage ? 'SmartifyOS' : await titleOf(name, root);
		const requester = { name, title };
		const udev = await readRules(root, requester, read.lists.udev);
		found.push({
			requester,
			lists: read.lists,
			rules: udev.rules,
			problems: [...read.problems, ...udev.problems],
		});
	}

	return mergeNeeds(found);
}

/** What one package lists, read and checked. */
export interface PackageFound {
	requester: Requester;
	lists: PackageLists;
	rules: UdevNeed[];
	problems: ListProblem[];
}

/**
 * Internal: SmartifyOS first, the car's app last, everything else by name, so that lists
 * and messages always come out in the same order.
 */
function byRequesterOrder(appDir: string) {
	const rank = ([name, root]: [string, string]) =>
		name === corePackage ? 0 : root === appDir ? 2 : 1;
	return (a: [string, string], b: [string, string]) =>
		rank(a) - rank(b) || a[0].localeCompare(b[0]);
}

/**
 * The lists in the pubspec of one package's folder, or undefined when it lists nothing.
 * A pubspec that is not valid YAML is simply skipped: pub could not have resolved it.
 */
export async function readPackageLists(
	root: string,
): Promise<{ lists: PackageLists; problems: ListProblem[] } | undefined> {
	let text: string;
	try {
		text = await Bun.file(join(root, 'pubspec.yaml')).text();
	} catch {
		return undefined;
	}
	// Most of the couple of hundred packages have nothing, and this spares parsing them.
	if (!/^smartify_os\s*:/m.test(text)) return undefined;

	let pubspec: Record<string, unknown>;
	try {
		pubspec = parsePubspec(text, join(root, 'pubspec.yaml')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (!('smartify_os' in pubspec)) return undefined;
	return parseLists(pubspec.smartify_os);
}

/**
 * Reads the udev rule files a package lists, and checks each can be installed: it has to
 * be there, and it may only set permissions.
 */
export async function readRules(
	root: string,
	requester: Requester,
	paths: string[],
): Promise<{ rules: UdevNeed[]; problems: ListProblem[] }> {
	const rules: UdevNeed[] = [];
	const problems: ListProblem[] = [];
	for (const [index, path] of paths.entries()) {
		const where = `smartify_os.linux.run.udev[${index}]`;
		const file = Bun.file(join(root, path));
		if (!(await file.exists())) {
			problems.push({ kind: 'invalid', path: where, message: `${path} is not in the package.` });
			continue;
		}
		const text = await file.text();
		const why = checkUdevRule(text);
		if (why) {
			problems.push({ kind: 'invalid', path: where, message: `${path}: ${why}` });
			continue;
		}
		rules.push({
			name: installedRuleName(requester.name, path),
			text,
			requester,
		});
	}
	return { rules, problems };
}

/**
 * Checks what one package lists, the way installing it would. For the commands that bring a
 * package into a car, which reject a mistake before it gets anywhere near one.
 */
export async function checkPackage(root: string, packageName: string): Promise<ListProblem[]> {
	const read = await readPackageLists(root);
	if (!read) return [];
	const udev = await readRules(root, { name: packageName, title: packageName }, read.lists.udev);
	return [...read.problems, ...udev.problems];
}

/** Merges what every package asked for into one set per list. */
export function mergeNeeds(found: PackageFound[]): CarNeeds {
	const build = new Map<string, AptNeed>();
	const run = new Map<string, AptNeed>();
	const groups = new Map<string, GroupNeed>();
	const problems: NeedProblem[] = [];

	for (const { requester, lists, problems: own } of found) {
		for (const entry of lists.build) addApt(build, entry, requester);
		for (const entry of lists.run) addApt(run, entry, requester);
		for (const group of lists.groups) {
			const need = groups.get(group) ?? { group, requesters: [] };
			addRequester(need.requesters, requester);
			groups.set(group, need);
		}
		for (const problem of own) problems.push({ ...problem, requester });
	}

	const sorted = <T>(map: Map<string, T>) =>
		[...map].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
	return {
		build: sorted(build),
		run: sorted(run),
		udev: found.flatMap(({ rules }) => rules),
		groups: sorted(groups),
		problems,
	};
}

/**
 * Internal: adds one apt entry. Asked for on every architecture by anyone means every
 * architecture, otherwise the architectures add up.
 */
function addApt(map: Map<string, AptNeed>, entry: AptEntry, requester: Requester): void {
	const existing = map.get(entry.package);
	if (!existing) {
		map.set(entry.package, {
			package: entry.package,
			arch: entry.arch ? [...entry.arch] : null,
			requesters: [requester],
		});
		return;
	}
	if (existing.arch === null || entry.arch === undefined) existing.arch = null;
	else existing.arch = [...new Set([...existing.arch, ...entry.arch])].sort() as LinuxArch[];
	addRequester(existing.requesters, requester);
}

function addRequester(list: Requester[], requester: Requester): void {
	if (!list.some((r) => r.name === requester.name)) list.push(requester);
}

/** The needs that apply on one architecture. */
export function forArch(needs: AptNeed[], arch: LinuxArch): AptNeed[] {
	return needs.filter((need) => need.arch === null || need.arch.includes(arch));
}
