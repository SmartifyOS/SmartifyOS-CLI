import { stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { pubGet } from '../flutter.ts';
import { lastLines } from '../process.ts';
import {
	dependsOnCore,
	type PackageSource,
	parsePubspec,
	readLock,
	readPackageRoots,
	readPubspecIn,
	sourceOf,
} from '../pubspec/read.ts';
import { corePackage } from '../smartify-os.ts';
import { type CarApp, carFiles } from './find.ts';
import { readLinks } from './links.ts';
import type { ExtensionEntry } from './main-dart.ts';

/**
 * What a car's app has installed: which SmartifyOS, which extensions, and where each one
 * comes from.
 *
 * Where a package comes from is read from `pubspec.yaml`, since that is what the CLI edits.
 * What it actually resolved to (version, commit, folder) is read from what pub wrote, which
 * is why pub has to have run first, see {@link ensureResolved}.
 */

/** One installed package, SmartifyOS itself or an extension. */
export interface Installed {
	/** The package name, `smartify_os_android_auto`. */
	name: string;
	/** What a person calls it, `Android Auto`. */
	title: string;
	/** Where pubspec.yaml says it comes from. The override wins over the dependency. */
	source: PackageSource;
	version: string | undefined;
	/** The exact commit, when it comes from git. */
	commit: string | undefined;
	/** The folder pub resolved it to. */
	root: string | undefined;
	/** The folder on this computer it is linked to, as written in pubspec_overrides.yaml. */
	link: string | undefined;
	/** What its own pubspec says about SmartifyOS, for an extension. */
	coreConstraint: unknown;
}

export interface CarState {
	app: CarApp;
	pubspecText: string;
	overridesText: string | undefined;
	links: Map<string, string>;
	core: Installed;
	extensions: Installed[];
}

/** Internal: the modification time of a file, or 0 when there is no such file. */
async function modified(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Runs `flutter pub get` when pub has not run since the pubspec last changed.
 *
 * @throws {CliError} with pub's own explanation when it cannot resolve.
 */
export async function ensureResolved(app: CarApp): Promise<void> {
	const files = carFiles(app);
	const resolved = await modified(files.packageConfig);
	const changed = Math.max(
		await modified(files.pubspec),
		await modified(files.overrides),
		await modified(files.lock),
	);
	if (resolved > 0 && resolved >= changed) return;

	const result = await pubGet(app.dir);
	if (result.code !== 0) {
		throw new CliError("The car's packages could not be fetched.", {
			hint: lastLines(`${result.stdout}\n${result.stderr}`),
		});
	}
}

/**
 * The name a person reads: the first heading of the package's README, which the template
 * makes the extension's name, or else the package name in words.
 */
export async function titleOf(name: string, root: string | undefined): Promise<string> {
	if (root) {
		try {
			const readme = await Bun.file(join(root, 'README.md')).text();
			const heading = /^#\s+(.+?)\s*$/m.exec(readme)?.[1];
			// A heading that is just the package name says nothing the fallback does not.
			if (heading && !/^[a-z0-9_]+$/.test(heading)) return heading;
		} catch {
			// No README, the name will do.
		}
	}
	return titleFromPackage(name);
}

/** `smartify_os_reverse_camera` becomes `Reverse Camera`. */
export function titleFromPackage(name: string): string {
	return name
		.replace(/^smartify_os_/, '')
		.split('_')
		.filter(Boolean)
		.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
		.join(' ');
}

/**
 * Reads everything the car has installed. Runs pub first when it has to.
 */
export async function readCar(app: CarApp): Promise<CarState> {
	await ensureResolved(app);

	const files = carFiles(app);
	const pubspecText = await Bun.file(files.pubspec).text();
	const pubspec = parsePubspec(pubspecText, 'pubspec.yaml');
	const overridesFile = Bun.file(files.overrides);
	const overridesText = (await overridesFile.exists()) ? await overridesFile.text() : undefined;
	const links = readLinks(overridesText);
	const roots = await readPackageRoots(app.dir);
	const lock = await readLock(app.dir);

	const describe = async (name: string): Promise<Installed> => {
		const root = roots.get(name);
		const own = root ? await readPubspecIn(root).catch(() => undefined) : undefined;
		const declared = pubspec.dependency_overrides?.[name] ?? pubspec.dependencies?.[name];
		return {
			name,
			title: name === corePackage ? 'SmartifyOS' : await titleOf(name, root),
			source: sourceOf(declared),
			version: lock.get(name)?.version,
			commit: lock.get(name)?.commit,
			root,
			link: links.get(name),
			coreConstraint: own?.pubspec.dependencies?.[corePackage],
		};
	};

	const extensions: Installed[] = [];
	for (const name of Object.keys(pubspec.dependencies ?? {})) {
		if (name === corePackage || name === 'flutter') continue;
		const root = roots.get(name);
		const own = root ? await readPubspecIn(root).catch(() => undefined) : undefined;
		if (own && dependsOnCore(own.pubspec)) extensions.push(await describe(name));
	}

	return {
		app,
		pubspecText,
		overridesText,
		links,
		core: await describe(corePackage),
		extensions,
	};
}

/**
 * Finds an installed extension by whatever a person might call it: the package name, the
 * package name without `smartify_os_`, or its title, in any case, with spaces or `_`.
 */
export function findInstalled(extensions: Installed[], query: string): Installed | undefined {
	const key = (text: string) => text.toLowerCase().replace(/[\s-]+/g, '_');
	const wanted = key(query);
	return extensions.find(
		(extension) =>
			key(extension.name) === wanted ||
			key(extension.name.replace(/^smartify_os_/, '')) === wanted ||
			key(extension.title) === wanted,
	);
}

/** How a package's version reads in a sentence: `0.3.0`, or `main (a1b2c3d)` on a branch. */
export function describeVersion(installed: Installed): string {
	if (installed.link) return `from ${installed.link}`;
	const source = installed.source;
	if (source.kind === 'git' && source.ref && !/^v\d/.test(source.ref)) {
		return `${source.ref}${installed.commit ? ` (${installed.commit.slice(0, 7)})` : ''}`;
	}
	if (source.kind === 'path') return `from ${source.path}`;
	return installed.version ?? 'unknown version';
}

/**
 * One installed package as plain data, the way `--json` reports it. Missing values are
 * null rather than left out, so a program can rely on every field being there.
 */
export interface PackageData {
	name: string;
	title: string;
	version: string | null;
	/** The exact commit, when it comes from git. */
	commit: string | null;
	/** Where pubspec.yaml says it comes from. */
	source: PackageSource;
	/** The folder on this computer it is linked to, when it is. */
	linkedTo: string | null;
	/** How the version reads in a sentence, see {@link describeVersion}. */
	label: string;
}

export function packageData(installed: Installed): PackageData {
	return {
		name: installed.name,
		title: installed.title,
		version: installed.version ?? null,
		commit: installed.commit ?? null,
		source: installed.source,
		linkedTo: installed.link ?? null,
		label: describeVersion(installed),
	};
}

/**
 * How a car's app switches an extension on: the class that extends `SmartifyOsExtension`,
 * and the library of the package that exports it.
 *
 * Found by reading the package, not by guessing from its name, so an extension that does not
 * follow the template's naming still works. Undefined when there is no such class, or when
 * its constructor needs something handed to it, which only the owner can write.
 */
export async function findEntry(
	packageName: string,
	root: string,
): Promise<ExtensionEntry | undefined> {
	const lib = join(root, 'lib');
	const glob = new Bun.Glob('**/*.dart');

	let classFile: string | undefined;
	let className: string | undefined;
	for await (const file of glob.scan({ cwd: lib })) {
		const text = await Bun.file(join(lib, file)).text();
		const match = /\bclass\s+(\w+)\s+extends\s+SmartifyOsExtension\b/.exec(text);
		if (match?.[1]) {
			classFile = file.replaceAll('\\', '/');
			className = match[1];
			break;
		}
	}
	if (!classFile || !className) return undefined;

	const classText = await Bun.file(join(lib, classFile)).text();
	const declared = new RegExp(`(const\\s+)?\\b${className}\\s*\\(([^)]*)\\)`).exec(classText);
	if (declared?.[2] && /\brequired\b|^\s*[A-Za-z_][\w<>?]*\s+\w+/.test(declared[2])) {
		return undefined;
	}

	const library = await publicLibrary(lib, classFile, packageName);
	if (!library) return undefined;

	return { packageName, library, className, isConst: Boolean(declared?.[1]) };
}

/**
 * Internal: the library directly in `lib/` that a car's app imports to get at the class:
 * the file itself when it is directly in `lib/`, or the one that exports it, or else the one
 * named after the package.
 */
async function publicLibrary(
	lib: string,
	classFile: string,
	packageName: string,
): Promise<string | undefined> {
	if (!classFile.includes('/')) return classFile;

	const top: string[] = [];
	for await (const file of new Bun.Glob('*.dart').scan({ cwd: lib })) top.push(file);

	for (const file of top.sort()) {
		const text = await Bun.file(join(lib, file)).text();
		if (text.includes(`'${classFile}'`) || text.includes(`"${classFile}"`)) return file;
	}

	const short = `${packageName.replace(/^smartify_os_/, '')}.dart`;
	if (top.includes(short)) return short;
	if (top.includes(`${packageName}.dart`)) return `${packageName}.dart`;
	return top.length === 1 ? top[0] : undefined;
}

/** A path as it reads from the car's app folder, for messages. */
export function fromApp(app: CarApp, path: string): string {
	const rel = relative(app.dir, path);
	return rel.startsWith('..') ? basename(path) : rel;
}

/**
 * The overrides the installed SmartifyOS needed, read from its own pubspec.yaml, so that
 * moving to another SmartifyOS takes out the ones it no longer needs.
 */
export async function overridesOfInstalledCore(state: CarState): Promise<string[]> {
	if (!state.core.root) return [];
	const own = await readPubspecIn(state.core.root).catch(() => undefined);
	return Object.keys(own?.pubspec.dependency_overrides ?? {});
}
