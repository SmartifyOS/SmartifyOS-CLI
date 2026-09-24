import { describe, expect, test } from 'bun:test';
import { changelogBetween, isReleaseTag, neededOverrides, newerThan } from './smartify-os.ts';

const changelog = `# Changelog

## 0.3.0

- Quick settings can be hidden.

## [v0.2.1]

- Fixes the clock.

## 0.2.0

- First release with extensions.
`;

describe('changelogBetween', () => {
	test('keeps what is new since the version the car has', () => {
		expect(changelogBetween(changelog, '0.2.0', '0.3.0')).toBe(
			'## 0.3.0\n\n- Quick settings can be hidden.\n\n## [v0.2.1]\n\n- Fixes the clock.',
		);
	});

	test('stops at the version being moved to', () => {
		expect(changelogBetween(changelog, '0.2.0', '0.2.1')).toBe('## [v0.2.1]\n\n- Fixes the clock.');
	});

	test('says nothing when there is nothing in the range', () => {
		expect(changelogBetween(changelog, '0.3.0', '0.3.0')).toBeUndefined();
		expect(changelogBetween('no headings', '0.1.0', '0.2.0')).toBeUndefined();
	});
});

describe('neededOverrides', () => {
	test('copies every override out of SmartifyOS, as written', () => {
		const core = `name: smartify_os_core

dependency_overrides:
  http: ^1.0.0
  # Why the fork.
  flutter_angle:
    git:
      url: https://github.com/Mauznemo/flutter_angle.git
      ref: main

dependencies:
  flutter:
    sdk: flutter
`;
		expect(neededOverrides(core)).toEqual([
			{ name: 'http', lines: ['http: ^1.0.0'] },
			{
				name: 'flutter_angle',
				lines: [
					'flutter_angle:',
					'  git:',
					'    url: https://github.com/Mauznemo/flutter_angle.git',
					'    ref: main',
				],
			},
		]);
	});
});

describe('isReleaseTag', () => {
	test('a v and a version is a release, a branch is not', () => {
		expect(isReleaseTag('v0.3.0')).toBe(true);
		expect(isReleaseTag('main')).toBe(false);
		expect(isReleaseTag('0.3.0')).toBe(false);
		expect(isReleaseTag(undefined)).toBe(false);
	});
});

describe('newerThan', () => {
	test('keeps only the releases after the given version', () => {
		const releases = ['0.3.0', '0.2.0', '0.1.0'].map((version) => ({
			tag: `v${version}`,
			version,
			commit: '',
		}));
		expect(newerThan(releases, '0.2.0').map((r) => r.version)).toEqual(['0.3.0']);
	});
});
