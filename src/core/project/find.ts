import { basename, dirname, join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { dependsOnCore, type Pubspec, readPubspecIn, sourceOf } from '../pubspec/read.ts';
import { corePackage } from '../smartify-os.ts';

/**
 * Working out what kind of folder the user is standing in.
 *
 * Nearly every command acts on a car's app or on an extension, and nobody should have to
 * say which or where: whatever `pubspec.yaml` is closest above the current folder decides.
 */

/** A car's app: the Flutter app that runs in the car. */
export interface CarApp {
	kind: 'car';
	dir: string;
}

/** An extension: a package that adds a feature to any car. */
export interface ExtensionFolder {
	kind: 'extension';
	dir: string;
	packageName: string;
}

export type Project = CarApp | ExtensionFolder;

/**
 * What a pubspec is.
 *
 * A car's app says where SmartifyOS comes from (an override, or a git or path dependency),
 * because it is the only place allowed to. An extension says only which version it needs.
 */
export function classify(pubspec: Pubspec): 'car' | 'extension' | undefined {
	if (pubspec.name === corePackage) return undefined;

	const overridden =
		pubspec.dependency_overrides != null && corePackage in pubspec.dependency_overrides;
	if (overridden) return 'car';
	if (!dependsOnCore(pubspec)) return undefined;

	const source = sourceOf(pubspec.dependencies?.[corePackage]);
	return source.kind === 'version' ? 'extension' : 'car';
}

/**
 * The project the given folder is in, or undefined when it is in none.
 *
 * An extension's `example` app counts as the extension, since that is what anyone working
 * in there is working on.
 */
export async function findProject(from: string): Promise<Project | undefined> {
	let dir = from;
	while (true) {
		const found = await readPubspecIn(dir);
		if (found) {
			const kind = classify(found.pubspec);
			if (basename(dir) === 'example') {
				const parent = await findProject(dirname(dir));
				if (parent?.kind === 'extension' && parent.dir === dirname(dir)) return parent;
			}
			if (kind === 'car') return { kind, dir };
			if (kind === 'extension') {
				return { kind, dir, packageName: String(found.pubspec.name ?? basename(dir)) };
			}
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The car's app the user is in.
 *
 * @throws {CliError} when they are not in one, saying where they are instead.
 */
export async function requireCar(from: string = process.cwd()): Promise<CarApp> {
	const project = await findProject(from);
	if (project?.kind === 'car') return project;

	if (project?.kind === 'extension') {
		throw new CliError('This is an extension, not a car.', {
			hint: "Run this in your car's app folder instead.",
		});
	}
	throw new CliError('There is no SmartifyOS car here.', {
		hint: "Run this in your car's app folder, the one with pubspec.yaml in it.",
	});
}

/**
 * The extension the user is in.
 *
 * @throws {CliError} when they are not in one.
 */
export async function requireExtension(from: string = process.cwd()): Promise<ExtensionFolder> {
	const project = await findProject(from);
	if (project?.kind === 'extension') return project;

	throw new CliError(
		project?.kind === 'car'
			? "This is a car's app, not an extension."
			: 'There is no extension here.',
		{ hint: "Run this in your extension's folder, the one with pubspec.yaml in it." },
	);
}

/** The files of a car's app the CLI reads and writes. */
export function carFiles(app: CarApp) {
	return {
		pubspec: join(app.dir, 'pubspec.yaml'),
		lock: join(app.dir, 'pubspec.lock'),
		overrides: join(app.dir, 'pubspec_overrides.yaml'),
		main: join(app.dir, 'lib', 'main.dart'),
		gitignore: join(app.dir, '.gitignore'),
		packageConfig: join(app.dir, '.dart_tool', 'package_config.json'),
	};
}
