import { CliError } from '../utils/errors.ts';
import { compareVersions, parseVersion } from '../utils/semver.ts';
import {
	defaultBranch,
	type GitSource,
	listReleases,
	type Release,
	readRemoteFile,
} from './git.ts';
import { entryLines, entryNames } from './pubspec/blocks.ts';
import { parsePubspec } from './pubspec/read.ts';

/**
 * Where SmartifyOS itself comes from.
 *
 * Every release is a `vX.Y.Z` tag of one repository, with the package in its
 * `smartify_os_core` folder and the template for new extensions next to it, so that the
 * template handed out always matches the SmartifyOS it was released with.
 */

/** The package name every car and every extension depends on. */
export const corePackage = 'smartify_os_core';

/** The folder of the repository the package is in. */
export const coreFolder = 'smartify_os_core';

/** The folder of the repository the extension template is in. */
export const templateFolder = 'smartify_os_extension_template';

/**
 * The SmartifyOS repository. `SMARTIFY_OS_CORE_REPO` points somewhere else, for trying a
 * fork or a local copy (`file:///...`) without publishing anything.
 */
export function coreRepoUrl(): string {
	return (
		process.env.SMARTIFY_OS_CORE_REPO ?? 'https://github.com/Mauznemo/smartify_os_flutter_test.git'
	);
}

/** Where SmartifyOS at one tag or branch comes from, the way a pubspec writes it. */
export function coreSource(ref: string): GitSource {
	return { url: coreRepoUrl(), path: coreFolder, ref };
}

/** Whether a ref is a release tag rather than a branch. */
export function isReleaseTag(ref: string | undefined): boolean {
	return typeof ref === 'string' && ref.startsWith('v') && parseVersion(ref) !== undefined;
}

/** Every SmartifyOS release, newest first. */
export async function coreReleases(): Promise<Release[]> {
	return await listReleases(coreRepoUrl());
}

/** What one SmartifyOS, at a tag or a branch, is. */
export interface CoreAt {
	source: GitSource;
	/** The version in its pubspec.yaml. */
	version: string;
	/** Its pubspec.yaml, which the overrides it needs are copied out of. */
	pubspecText: string;
}

/** Reads SmartifyOS's pubspec.yaml at a tag or branch. */
export async function coreAt(ref: string): Promise<CoreAt> {
	const text = await readRemoteFile(coreRepoUrl(), ref, `${coreFolder}/pubspec.yaml`);
	if (!text) {
		throw new CliError(`SmartifyOS ${ref} could not be found.`, {
			hint: 'Check the version, `smartify-os update --help` shows how to pick one.',
		});
	}
	const version = parsePubspec(text, `SmartifyOS ${ref}`).version;
	return {
		source: coreSource(ref),
		version: typeof version === 'string' ? version : '0.0.0',
		pubspecText: text,
	};
}

/**
 * The SmartifyOS someone starting out should get: the newest release, or the newest commit
 * while there has not been a release yet.
 */
export async function newestCore(): Promise<CoreAt> {
	const [newest] = await coreReleases();
	if (newest) return await coreAt(newest.tag);
	const { branch } = await defaultBranch(coreRepoUrl());
	return await coreAt(branch);
}

/** The releases newer than a version, newest first. */
export function newerThan(releases: Release[], version: string): Release[] {
	return releases.filter((release) => compareVersions(release.version, version) > 0);
}

/** One override SmartifyOS needs every app to repeat, as the lines it is written in. */
export interface NeededOverride {
	name: string;
	lines: string[];
}

/**
 * The overrides in SmartifyOS's own pubspec.yaml.
 *
 * An override only applies in the package it is written in, so every app that uses
 * SmartifyOS has to repeat these (today `flutter_angle` and `http`). They are copied as they
 * are written rather than understood, so whatever shape the next one takes, it still works.
 */
export function neededOverrides(corePubspecText: string): NeededOverride[] {
	return entryNames(corePubspecText, 'dependency_overrides').flatMap((name) => {
		const lines = entryLines(corePubspecText, 'dependency_overrides', name);
		return lines ? [{ name, lines }] : [];
	});
}

/**
 * The part of a changelog that is new between two versions, `from` left out.
 *
 * Reads `## 0.3.0` headings, with or without a `v` or brackets. Undefined when no section
 * is in the range, so the caller can simply say nothing.
 */
export function changelogBetween(text: string, from: string, to: string): string | undefined {
	const kept: string[][] = [];
	let current: string[] | undefined;

	for (const line of text.split(/\r?\n/)) {
		const version = /^##\s+\[?v?(\d+\.\d+\.\d+[^\s\]]*)/.exec(line)?.[1];
		if (version) {
			const inRange = compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
			current = inRange ? [line] : undefined;
			if (current) kept.push(current);
		} else if (/^#\s/.test(line)) {
			current = undefined;
		} else {
			current?.push(line);
		}
	}

	const result = kept.map((section) => section.join('\n').trim()).join('\n\n');
	return result || undefined;
}
