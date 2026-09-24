import { entryLines, entryNames } from '../pubspec/blocks.ts';
import { parsePubspec, sourceOf } from '../pubspec/read.ts';
import { pathEntry } from './block.ts';

/**
 * `pubspec_overrides.yaml`: the car's app using a copy of SmartifyOS or of an extension
 * from a folder on this computer, for someone working on one next to their car.
 *
 * Pub reads that file **instead of** the overrides in `pubspec.yaml`, not on top of them. So
 * it is always written whole: every override from `pubspec.yaml`, with the linked ones
 * swapped for their folder. Which packages are linked is read back out of the file itself,
 * as the ones pointing at a folder, so there is nothing else to keep in step.
 */

export const overridesFileName = 'pubspec_overrides.yaml';

const header = [
	'# Written by `smartify-os link`: this car uses the copies of SmartifyOS and its',
	'# extensions in these folders, instead of the ones pubspec.yaml names. The folders',
	'# are on this computer only, so this file is never committed.',
	'#',
	'# Pub reads this file instead of the overrides in pubspec.yaml, so all of those are',
	'# repeated here. `smartify-os unlink` puts everything back and deletes this file.',
];

/** The linked packages, each with the folder it is linked to, as written. */
export function readLinks(overridesText: string | undefined): Map<string, string> {
	const links = new Map<string, string>();
	if (!overridesText) return links;

	const overrides = parsePubspec(overridesText, overridesFileName).dependency_overrides ?? {};
	for (const [name, value] of Object.entries(overrides)) {
		const source = sourceOf(value);
		if (source.kind === 'path') links.set(name, source.path);
	}
	return links;
}

/**
 * The whole of `pubspec_overrides.yaml` for a set of links.
 *
 * Every override in `pubspec.yaml` comes first, in its order, as written or as its link.
 * A linked package `pubspec.yaml` has no override for, an extension not installed from
 * anywhere yet, goes at the end.
 */
export function renderOverrides(pubspecText: string, links: Map<string, string>): string {
	const lines = [...header, 'dependency_overrides:'];
	const names = entryNames(pubspecText, 'dependency_overrides');

	const add = (entry: string[]) => {
		for (const line of entry) lines.push(`  ${line}`);
	};

	for (const name of names) {
		const link = links.get(name);
		if (link !== undefined) add(pathEntry(name, link));
		else add(entryLines(pubspecText, 'dependency_overrides', name) ?? []);
	}
	for (const [name, link] of links) {
		if (!names.includes(name)) add(pathEntry(name, link));
	}

	return `${lines.join('\n')}\n`;
}

/**
 * The `.gitignore` of the app with `pubspec_overrides.yaml` in it, or undefined when it is
 * in there already.
 */
export function ignoreOverrides(gitignore: string | undefined): string | undefined {
	const text = gitignore ?? '';
	const listed = text
		.split(/\r?\n/)
		.some((line) => /^\/?(\*\*\/)?pubspec_overrides\.yaml$/.test(line.trim()));
	if (listed) return undefined;

	const lead = text === '' || text.endsWith('\n') ? '' : '\n';
	const gap = text === '' ? '' : '\n';
	return `${text}${lead}${gap}# Folders on this computer, written by smartify-os link.\n/pubspec_overrides.yaml\n`;
}
