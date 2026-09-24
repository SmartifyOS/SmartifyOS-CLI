import { rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { analyzeErrors, type Problem, packageConfigPath, pubGet, pubUpgrade } from '../flutter.ts';
import { lastLines } from '../process.ts';
import { dependsOnCore, readPackageRoots, readPubspecIn } from '../pubspec/read.ts';
import { corePackage } from '../smartify-os.ts';
import { type CarApp, carFiles } from './find.ts';
import { readLinks, renderOverrides } from './links.ts';

/**
 * Trying a change to a car's app, and taking it back when it does not build.
 *
 * Every command that changes what the car runs goes through {@link tryChange}. Pub never
 * checks an extension's SmartifyOS version (the car's override hides it), and nobody can
 * know which future SmartifyOS breaks an extension, so the only real answer to "does this
 * still work" is to fetch it and analyze it. On errors every file goes back as it was.
 */

export type ChangeStep = 'fetch' | 'check' | 'undo';

/** What is being changed, and how. */
export interface Change {
	/** Writes the change. Everything it touches has to be one of the car's files. */
	edit(): Promise<void>;
	/** Packages to move on to their newest commit once fetched, for those on a branch. */
	upgrade?: string[];
	/** Runs once the new packages are fetched, for edits that need to read them. */
	afterFetch?(): Promise<void>;
	/**
	 * Whether to analyze. Off only for pointing the car at a folder on this computer, where
	 * code that does not build yet is simply work in progress.
	 */
	check?: boolean;
	onStep?(step: ChangeStep): void;
}

/** Why a change was taken back. */
export type ChangeFailure =
	/** Pub could not fit the packages together. `output` is its explanation. */
	| { kind: 'fetch'; output: string }
	/** It fetched, but does not build. The errors, by the package they are in. */
	| { kind: 'build'; problems: PackageProblems[] };

/** The errors in one package. `name` is undefined for the car's app itself. */
export interface PackageProblems {
	name: string | undefined;
	problems: Problem[];
}

export type ChangeResult = { ok: true } | { ok: false; failure: ChangeFailure };

/** Internal: what the car's files hold at one moment, undefined for a file that is not there. */
type Snapshot = Map<string, string | undefined>;

async function snapshot(app: CarApp): Promise<Snapshot> {
	const files = carFiles(app);
	const taken: Snapshot = new Map();
	for (const path of [files.pubspec, files.lock, files.overrides, files.main, files.gitignore]) {
		const file = Bun.file(path);
		taken.set(path, (await file.exists()) ? await file.text() : undefined);
	}
	return taken;
}

async function restore(taken: Snapshot): Promise<void> {
	for (const [path, text] of taken) {
		if (text === undefined) await rm(path, { force: true });
		else await Bun.write(path, text);
	}
}

/**
 * Writes the car's pubspec.yaml, and `pubspec_overrides.yaml` with it when anything is linked,
 * since pub reads that file instead of the overrides in pubspec.yaml and it would otherwise
 * go on pointing at the old ones.
 */
export async function writePubspec(app: CarApp, text: string): Promise<void> {
	const files = carFiles(app);
	await Bun.write(files.pubspec, text);

	const overrides = Bun.file(files.overrides);
	if (!(await overrides.exists())) return;
	const links = readLinks(await overrides.text());
	if (links.size > 0) await Bun.write(files.overrides, renderOverrides(text, links));
}

/**
 * Writes `pubspec_overrides.yaml` for a set of links, or deletes it when nothing is linked
 * any more, which is what puts the car back on what pubspec.yaml says.
 */
export async function writeLinks(
	app: CarApp,
	pubspecText: string,
	links: Map<string, string>,
): Promise<void> {
	const path = carFiles(app).overrides;
	if (links.size === 0) await rm(path, { force: true });
	else await Bun.write(path, renderOverrides(pubspecText, links));
}

/**
 * Makes a change, fetches it and analyzes the car's app and every extension. Keeps it when
 * it builds, puts everything back when it does not.
 *
 * Errors the app already had before the change are not the change's fault. They are only
 * looked for when there are errors at all, so the usual case costs one analysis, not two.
 */
export async function tryChange(app: CarApp, change: Change): Promise<ChangeResult> {
	const before = await snapshot(app);

	const undo = async () => {
		change.onStep?.('undo');
		await restore(before);
		await pubGet(app.dir);
	};

	try {
		await change.edit();

		change.onStep?.('fetch');
		const fetched = await pubGet(app.dir);
		if (fetched.code !== 0) {
			await undo();
			return {
				ok: false,
				failure: { kind: 'fetch', output: pubExplanation(fetched.stderr, fetched.stdout) },
			};
		}
		if (change.upgrade?.length) {
			const upgraded = await pubUpgrade(app.dir, change.upgrade);
			if (upgraded.code !== 0) {
				await undo();
				return {
					ok: false,
					failure: { kind: 'fetch', output: pubExplanation(upgraded.stderr, upgraded.stdout) },
				};
			}
		}
		await change.afterFetch?.();
	} catch (error) {
		await undo();
		throw error;
	}

	if (change.check === false) return { ok: true };

	const after = await snapshot(app);

	change.onStep?.('check');
	const errors = await checkBuild(app);
	if (errors.length === 0) return { ok: true };

	await undo();
	const already = new Set((await checkBuild(app)).map(problemKey));
	const caused = errors.filter((problem) => !already.has(problemKey(problem)));

	if (caused.length === 0) {
		// Every error was there before the change, so the change itself is fine.
		await restore(after);
		await pubGet(app.dir);
		return { ok: true };
	}

	return { ok: false, failure: { kind: 'build', problems: groupByPackage(caused) } };
}

/** Internal: an error with the package it is in, which is what makes two runs comparable. */
interface LocatedProblem extends Problem {
	packageName: string | undefined;
	/** The file, relative to its package. */
	path: string;
}

function problemKey(problem: LocatedProblem): string {
	return `${problem.packageName ?? ''}|${problem.path}|${problem.code}|${problem.message}`;
}

/**
 * Analyzes the car's app, and the `lib` of every extension as the app resolved it.
 *
 * SmartifyOS itself is not analyzed: it is tested before every release, and it is big.
 */
export async function checkBuild(app: CarApp): Promise<LocatedProblem[]> {
	const roots = await readPackageRoots(app.dir);
	const app_ = await readPubspecIn(app.dir);
	const extensions: { name: string; root: string }[] = [];

	for (const name of Object.keys(app_?.pubspec.dependencies ?? {})) {
		const root = roots.get(name);
		if (name === corePackage || !root) continue;
		const own = await readPubspecIn(root).catch(() => undefined);
		if (own && dependsOnCore(own.pubspec)) extensions.push({ name, root });
	}

	const problems = await analyzeErrors(
		[app.dir, ...extensions.map((extension) => join(extension.root, 'lib'))],
		packageConfigPath(app.dir),
	);

	return problems.map((problem) => {
		const owner = extensions.find((extension) => isInside(problem.file, extension.root));
		const base = owner?.root ?? app.dir;
		return { ...problem, packageName: owner?.name, path: relative(base, problem.file) };
	});
}

function isInside(file: string, dir: string): boolean {
	return file === dir || file.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function groupByPackage(problems: LocatedProblem[]): PackageProblems[] {
	const groups = new Map<string | undefined, Problem[]>();
	for (const problem of problems) {
		const list = groups.get(problem.packageName) ?? [];
		list.push({ ...problem, file: problem.path });
		groups.set(problem.packageName, list);
	}
	return [...groups].map(([name, list]) => ({ name, problems: list }));
}

/**
 * Internal: the part of pub's output that says why it could not fit the packages together.
 *
 * Pub starts every failure with a long list of what it resolved first. Its reason starts at
 * "Because", which is the only part worth reading.
 */
function pubExplanation(stderr: string, stdout: string): string {
	const output = `${stdout}\n${stderr}`;
	const because = output.indexOf('Because ');
	return because === -1 ? lastLines(output) : lastLines(output.slice(because), 20);
}
