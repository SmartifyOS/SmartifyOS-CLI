import { describe, expect, test } from 'bun:test';
import { compareVersions, isNewer, lowerBound, meetsLowerBound, parseVersion } from './semver.ts';

describe('parseVersion', () => {
	test('reads a plain version', () => {
		expect(parseVersion('1.2.3')).toEqual({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: [],
		});
	});

	test('ignores a leading v, which is what the git tags carry', () => {
		expect(parseVersion('v0.1.1')).toEqual({ major: 0, minor: 1, patch: 1, prerelease: [] });
	});

	test('fills in a missing minor or patch', () => {
		expect(parseVersion('1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
		expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: [] });
	});

	test('splits the prerelease off', () => {
		expect(parseVersion('1.2.3-beta.1')?.prerelease).toEqual(['beta', '1']);
	});

	test('drops build metadata, which does not count towards precedence', () => {
		expect(parseVersion('1.2.3+build.5')).toEqual({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: [],
		});
		expect(parseVersion('1.2.3-rc.1+build.5')?.prerelease).toEqual(['rc', '1']);
	});

	test('says nothing rather than guessing at input that is not a version', () => {
		for (const input of ['', 'latest', 'v', '1.2.3.4', 'nightly', '1.2.3-', 'a.b.c']) {
			expect(parseVersion(input)).toBeUndefined();
		}
	});
});

describe('compareVersions', () => {
	test('orders by major, then minor, then patch', () => {
		expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
		expect(compareVersions('1.2.0', '1.1.0')).toBe(1);
		expect(compareVersions('1.1.1', '1.1.2')).toBe(-1);
		expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
	});

	test('does not care whether one side has a v and the other does not', () => {
		expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
	});

	test('ignores build metadata', () => {
		expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
	});

	test('a prerelease is older than the release it leads up to', () => {
		expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
		expect(compareVersions('1.0.0', '1.0.0-alpha')).toBe(1);
	});

	test('numbered prereleases compare as numbers, not as text', () => {
		expect(compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10')).toBe(-1);
		expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
	});

	test('fewer identifiers sorts first, and numbers sort below words', () => {
		expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
		expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
	});

	test('anything unreadable sorts below anything readable, and never throws', () => {
		expect(compareVersions('nonsense', '1.0.0')).toBe(-1);
		expect(compareVersions('1.0.0', 'nonsense')).toBe(1);
		expect(compareVersions('nonsense', 'rubbish')).toBe(0);
	});
});

describe('isNewer', () => {
	test('true only when there is really something newer', () => {
		expect(isNewer('0.2.0', '0.1.1')).toBe(true);
		expect(isNewer('0.1.1', '0.1.1')).toBe(false);
		expect(isNewer('0.1.0', '0.1.1')).toBe(false);
	});

	test('someone on a normal release is never told about a prerelease', () => {
		expect(isNewer('0.2.0-beta.1', '0.1.1')).toBe(false);
	});

	test('someone already on a prerelease hears about the next one and about the release', () => {
		expect(isNewer('0.2.0-beta.2', '0.2.0-beta.1')).toBe(true);
		expect(isNewer('0.2.0', '0.2.0-beta.1')).toBe(true);
	});

	test('a garbled answer never turns into a notice', () => {
		expect(isNewer('nonsense', '0.1.1')).toBe(false);
		expect(isNewer('0.2.0', 'nonsense')).toBe(false);
		expect(isNewer('', '')).toBe(false);
	});
});

describe('lowerBound', () => {
	test('reads every shape an extension writes', () => {
		expect(lowerBound('>=0.2.0')).toBe('0.2.0');
		expect(lowerBound('>=0.2.0 <1.0.0')).toBe('0.2.0');
		expect(lowerBound('^0.2.0')).toBe('0.2.0');
		expect(lowerBound('0.2.0')).toBe('0.2.0');
		expect(lowerBound('>= 0.2.0')).toBe('0.2.0');
	});

	test('any, nothing and a git or path source mean there is no bound', () => {
		expect(lowerBound('any')).toBeUndefined();
		expect(lowerBound(undefined)).toBeUndefined();
		expect(lowerBound(null)).toBeUndefined();
		expect(lowerBound({ git: 'https://example.com' })).toBeUndefined();
	});
});

describe('meetsLowerBound', () => {
	test('the bound itself fits, anything older does not', () => {
		expect(meetsLowerBound('>=0.2.0', '0.2.0')).toBe(true);
		expect(meetsLowerBound('>=0.2.0', '0.3.1')).toBe(true);
		expect(meetsLowerBound('>=0.2.0', '0.1.9')).toBe(false);
	});

	test('a strict bound leaves out the version it names', () => {
		expect(meetsLowerBound('>0.2.0', '0.2.0')).toBe(false);
		expect(meetsLowerBound('>0.2.0', '0.2.1')).toBe(true);
	});

	test('no bound fits everything', () => {
		expect(meetsLowerBound('any', '0.0.1')).toBe(true);
		expect(meetsLowerBound(undefined, '0.0.1')).toBe(true);
	});

	test('an upper bound is not what this checks', () => {
		expect(meetsLowerBound('>=0.2.0 <0.3.0', '0.5.0')).toBe(true);
	});
});
