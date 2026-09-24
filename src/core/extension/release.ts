import { parseVersion } from '../../utils/semver.ts';

/**
 * The bookkeeping of a release: the next version number, and its changelog entry.
 */

/** What kind of change a release is. */
export type ReleaseKind = 'fix' | 'feature';

/**
 * The version after `current`: `0.1.0` becomes `0.1.1` for a fix, `0.2.0` for something new.
 *
 * Something new only ever raises the middle number, even from 1.0.0 on, since an extension
 * that breaks the cars using it is not something to make easy.
 */
export function nextVersion(current: string, kind: ReleaseKind): string {
	const parsed = parseVersion(current) ?? { major: 0, minor: 1, patch: 0, prerelease: [] };
	// A prerelease becomes the release it was leading up to.
	if (parsed.prerelease.length > 0) return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
	if (kind === 'fix') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
	return `${parsed.major}.${parsed.minor + 1}.0`;
}

/** A pubspec with its version replaced, and nothing else touched. */
export function setVersion(pubspecText: string, version: string): string {
	return /^version:.*$/m.test(pubspecText)
		? pubspecText.replace(/^version:.*$/m, `version: ${version}`)
		: pubspecText.replace(/^(name:.*)$/m, `$1\nversion: ${version}`);
}

/** A changelog with a new entry at the top, above every other version. */
export function addChangelogEntry(changelog: string, version: string, notes: string[]): string {
	const entry = `## ${version}\n\n${notes.map((line) => `- ${line}`).join('\n')}\n`;
	const firstVersion = changelog.search(/^##\s/m);
	if (firstVersion === -1) return `${changelog.trimEnd()}${changelog.trim() ? '\n\n' : ''}${entry}`;
	return `${changelog.slice(0, firstVersion)}${entry}\n${changelog.slice(firstVersion)}`;
}
