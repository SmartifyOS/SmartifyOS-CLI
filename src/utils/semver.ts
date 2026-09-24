/**
 * Just enough of semver to answer two questions: is the release GitHub is offering newer
 * than the one that is installed, and does a version meet the lower bound in a pubspec?
 *
 * This is deliberately not a semver library. It compares two version strings that this
 * project itself published, so it can afford to be small and to treat anything it does not
 * understand as "no answer" rather than as an error.
 */

/** One version, taken apart. */
export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	/** Dot separated prerelease identifiers, empty for a normal release. */
	prerelease: string[];
}

const pattern = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Reads `0.2.0`, `v0.2.0`, `0.2.0-beta.1` or `0.2.0+build.5`.
 *
 * Returns undefined for anything else, which is the whole point: a garbled answer from the
 * network must never turn into a version number.
 */
export function parseVersion(input: string): ParsedVersion | undefined {
	// Build metadata is explicitly not part of precedence in semver, so drop it first.
	const [withoutBuild = ''] = input.trim().split('+');
	const match = pattern.exec(withoutBuild);
	if (!match) return undefined;

	const prerelease = match[4] ? match[4].split('.') : [];
	// A trailing or doubled dot leaves an empty identifier behind, which is not a version.
	if (prerelease.some((part) => part === '')) return undefined;

	return {
		major: Number(match[1]),
		minor: Number(match[2] ?? 0),
		patch: Number(match[3] ?? 0),
		prerelease,
	};
}

/**
 * Compares two prerelease identifier lists the way semver says to.
 *
 * The rules that matter here: a version with no prerelease beats the same version with one,
 * all digit identifiers compare as numbers so `alpha.9` sorts below `alpha.10`, all digit
 * sorts below alphanumeric, and when everything matches the longer list wins.
 */
function comparePrerelease(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;

	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i];
		const right = b[i];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;

		const leftIsNumber = /^\d+$/.test(left);
		const rightIsNumber = /^\d+$/.test(right);
		if (leftIsNumber && rightIsNumber) return Number(left) < Number(right) ? -1 : 1;
		if (leftIsNumber) return -1;
		if (rightIsNumber) return 1;
		return left < right ? -1 : 1;
	}

	return 0;
}

/**
 * Orders two versions: -1 when `a` is older, 0 when they are the same, 1 when `a` is newer.
 *
 * Anything that does not parse sorts below anything that does, rather than throwing. Nobody
 * should get a stack trace because a proxy returned an HTML page.
 */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);

	if (!left && !right) return 0;
	if (!left) return -1;
	if (!right) return 1;

	if (left.major !== right.major) return left.major < right.major ? -1 : 1;
	if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
	if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

	return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Whether `candidate` is worth telling someone on `current` about.
 *
 * Stricter than a plain comparison on purpose. Someone running a normal release is never
 * told about a beta, because they did not opt into one and would have no way to judge it.
 * Someone already on `0.2.0-beta.1` does hear about `0.2.0-beta.2` and about `0.2.0`.
 */
export function isNewer(candidate: string, current: string): boolean {
	const next = parseVersion(candidate);
	const now = parseVersion(current);
	if (!next || !now) return false;

	if (next.prerelease.length > 0 && now.prerelease.length === 0) return false;

	return compareVersions(candidate, current) > 0;
}

/**
 * The oldest version a pub version constraint allows, when it says.
 *
 * Reads the shapes an extension uses for `smartify_os_core`: `">=0.2.0"`, `">=0.2.0 <1.0.0"`,
 * `^0.2.0` and a bare `0.2.0`. Undefined for `any`, for no constraint at all, and for
 * anything it cannot read, all of which mean "no lower bound" to the caller.
 */
export function lowerBound(constraint: unknown): string | undefined {
	return readLowerBound(constraint)?.version;
}

/**
 * Whether `version` is at or above the lower bound of `constraint`.
 *
 * Only the lower bound is checked. Extensions are asked not to give an upper one, and when one
 * does, trying the change is what finds out whether it really does not fit.
 */
export function meetsLowerBound(constraint: unknown, version: string): boolean {
	const bound = readLowerBound(constraint);
	if (!bound) return true;
	const order = compareVersions(version, bound.version);
	return bound.inclusive ? order >= 0 : order > 0;
}

/** Internal: the lower bound and whether it is itself allowed (`>=`) or not (`>`). */
function readLowerBound(constraint: unknown): { version: string; inclusive: boolean } | undefined {
	if (typeof constraint !== 'string') return undefined;

	// Pub allows a space after the operator, so join it back on before splitting.
	for (const token of constraint
		.trim()
		.replace(/(>=|>|\^)\s+/g, '$1')
		.split(/\s+/)) {
		const match = /^(>=|>|\^)?\s*(v?\d[^\s<>=]*)$/.exec(token);
		if (!match?.[2] || !parseVersion(match[2])) continue;
		return { version: match[2].replace(/^v/, ''), inclusive: match[1] !== '>' };
	}

	return undefined;
}
