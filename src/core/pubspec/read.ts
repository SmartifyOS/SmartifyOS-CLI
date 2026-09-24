import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CliError } from '../../utils/errors.ts';

/**
 * Reading what a pubspec, a lock file and pub's package config say.
 *
 * Reading is done with a real YAML parser. Only writing goes line by line (see blocks.ts),
 * because only writing has to keep the owner's comments.
 */

/** The parts of a pubspec the CLI looks at. */
export interface Pubspec {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	dependencies?: Record<string, unknown> | null;
	dependency_overrides?: Record<string, unknown> | null;
}

/** Where a package comes from, as a pubspec says it. */
export type PackageSource =
	| { kind: 'git'; url: string; path?: string | undefined; ref?: string | undefined }
	| { kind: 'path'; path: string }
	| { kind: 'version'; constraint: string }
	| { kind: 'other' };

/**
 * Parses a pubspec.
 *
 * @throws {CliError} naming the file, when it is not valid YAML.
 */
export function parsePubspec(text: string, where: string): Pubspec {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(text);
	} catch (error) {
		throw new CliError(`${where} is not valid YAML, so it cannot be read.`, {
			hint: `${error instanceof Error ? error.message : String(error)}\nFix the file and try again.`,
		});
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
	return parsed as Pubspec;
}

/** The pubspec in a folder, or undefined when there is none. */
export async function readPubspecIn(
	dir: string,
): Promise<{ text: string; pubspec: Pubspec } | undefined> {
	const file = Bun.file(join(dir, 'pubspec.yaml'));
	if (!(await file.exists())) return undefined;
	const text = await file.text();
	return { text, pubspec: parsePubspec(text, join(dir, 'pubspec.yaml')) };
}

/** Reads one dependency entry, whichever of pub's shapes it is written in. */
export function sourceOf(value: unknown): PackageSource {
	if (value === null || value === undefined) return { kind: 'version', constraint: 'any' };
	if (typeof value === 'string') return { kind: 'version', constraint: value };
	if (typeof value !== 'object') return { kind: 'other' };

	const entry = value as Record<string, unknown>;
	if (typeof entry.path === 'string') return { kind: 'path', path: entry.path };

	if (typeof entry.git === 'string') return { kind: 'git', url: entry.git };
	if (typeof entry.git === 'object' && entry.git !== null) {
		const git = entry.git as Record<string, unknown>;
		if (typeof git.url === 'string') {
			return {
				kind: 'git',
				url: git.url,
				path: typeof git.path === 'string' ? git.path : undefined,
				ref: typeof git.ref === 'string' ? git.ref : undefined,
			};
		}
	}

	return { kind: 'other' };
}

/** Whether a pubspec depends on SmartifyOS at all. */
export function dependsOnCore(pubspec: Pubspec): boolean {
	return pubspec.dependencies != null && 'smartify_os_core' in pubspec.dependencies;
}

/**
 * Which folder every package of an app was resolved to, as absolute paths, read from
 * `.dart_tool/package_config.json`. Empty when pub has not run yet.
 */
export async function readPackageRoots(appDir: string): Promise<Map<string, string>> {
	const configPath = join(appDir, '.dart_tool', 'package_config.json');
	const roots = new Map<string, string>();

	let config: unknown;
	try {
		config = await Bun.file(configPath).json();
	} catch {
		return roots;
	}

	const packages = (config as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return roots;

	const base = pathToFileURL(`${dirname(configPath)}/`);
	for (const entry of packages) {
		const { name, rootUri } = entry as { name?: unknown; rootUri?: unknown };
		if (typeof name !== 'string' || typeof rootUri !== 'string') continue;
		try {
			roots.set(name, fileURLToPath(new URL(rootUri, base)).replace(/[\\/]$/, ''));
		} catch {
			// A root that is not a file is nothing the CLI can read anyway.
		}
	}
	return roots;
}

/** What pubspec.lock says about one package. */
export interface LockedPackage {
	version?: string | undefined;
	/** The exact commit, for a package from git. */
	commit?: string | undefined;
}

/** Reads pubspec.lock. Empty when there is none. */
export async function readLock(appDir: string): Promise<Map<string, LockedPackage>> {
	const locked = new Map<string, LockedPackage>();
	const file = Bun.file(join(appDir, 'pubspec.lock'));
	if (!(await file.exists())) return locked;

	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(await file.text());
	} catch {
		return locked;
	}

	const packages = (parsed as { packages?: unknown })?.packages;
	if (typeof packages !== 'object' || packages === null) return locked;

	for (const [name, value] of Object.entries(packages as Record<string, unknown>)) {
		const entry = value as { version?: unknown; description?: unknown };
		const description = entry.description as Record<string, unknown> | undefined;
		locked.set(name, {
			version: typeof entry.version === 'string' ? entry.version : undefined,
			commit:
				typeof description?.['resolved-ref'] === 'string'
					? (description['resolved-ref'] as string)
					: undefined,
		});
	}
	return locked;
}
