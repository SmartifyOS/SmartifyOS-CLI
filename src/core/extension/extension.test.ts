import { describe, expect, test } from 'bun:test';
import { CliError } from '../../utils/errors.ts';
import { extensionNames, extensionOverrides, finishPubspec, renameText } from './create.ts';
import { addChangelogEntry, nextVersion, setVersion } from './release.ts';

describe('extensionNames', () => {
	test('gives every spelling of a name', () => {
		expect(extensionNames('Reverse camera')).toEqual({
			name: 'Reverse camera',
			snake: 'reverse_camera',
			pascal: 'ReverseCamera',
			packageName: 'smartify_os_reverse_camera',
		});
	});

	test('tidies spaces and keeps digits', () => {
		expect(extensionNames('  OBD   reader 2 ')).toEqual({
			name: 'OBD reader 2',
			snake: 'obd_reader_2',
			pascal: 'ObdReader2',
			packageName: 'smartify_os_obd_reader_2',
		});
	});

	test('refuses what cannot be a package', () => {
		for (const name of ['', '2cool', 'Rear-camera', 'Café', 'class']) {
			expect(() => extensionNames(name)).toThrow(CliError);
		}
	});
});

describe('renameText', () => {
	test('replaces all three spellings the template uses', () => {
		const names = extensionNames('Reverse camera');
		expect(
			renameText(
				"import 'package:smartify_os_my_feature/src/my_feature.dart';\nclass MyFeatureExtension {} // My feature",
				names,
			),
		).toBe(
			"import 'package:smartify_os_reverse_camera/src/reverse_camera.dart';\nclass ReverseCameraExtension {} // Reverse camera",
		);
	});
});

describe('finishPubspec', () => {
	const template = `name: smartify_os_my_feature
description: "My feature for SmartifyOS."
version: 0.1.0

dependencies:
  flutter:
    sdk: flutter

  # The oldest SmartifyOS this works with.
  smartify_os_core: ">=0.0.1"
  shared_preferences: any
`;

	test('sets the lower bound and the description, and keeps the comments', () => {
		const result = finishPubspec(template, 'Shows the "reverse" camera', '0.3.0');
		expect(result).toContain(
			'  # The oldest SmartifyOS this works with.\n  smartify_os_core: ">=0.3.0"\n',
		);
		expect(result).toContain('description: "Shows the \\"reverse\\" camera"');
	});

	test('keeps the template description when none is given', () => {
		expect(finishPubspec(template, undefined, '0.3.0')).toContain('description: "My feature for');
	});
});

describe('extensionOverrides', () => {
	test('points at a release', () => {
		const text = extensionOverrides({
			kind: 'git',
			source: { url: 'https://example.com/core.git', path: 'smartify_os_core', ref: 'v0.3.0' },
		});
		expect(Bun.YAML.parse(text)).toEqual({
			dependency_overrides: {
				smartify_os_core: {
					git: { url: 'https://example.com/core.git', path: 'smartify_os_core', ref: 'v0.3.0' },
				},
			},
		});
	});

	test('points at a folder, with what SmartifyOS needs for an app', () => {
		const text = extensionOverrides({ kind: 'path', path: '../../smartify_os_core' }, [
			{ name: 'http', lines: ['http: ^1.0.0'] },
		]);
		expect(Bun.YAML.parse(text)).toEqual({
			dependency_overrides: {
				smartify_os_core: { path: '../../smartify_os_core' },
				http: '^1.0.0',
			},
		});
	});
});

describe('nextVersion', () => {
	test('a fix raises the last number, something new the middle one', () => {
		expect(nextVersion('0.1.0', 'fix')).toBe('0.1.1');
		expect(nextVersion('0.1.3', 'feature')).toBe('0.2.0');
		expect(nextVersion('1.4.2', 'feature')).toBe('1.5.0');
	});

	test('drops what pub adds after a plus, and finishes a prerelease', () => {
		expect(nextVersion('0.1.0+3', 'fix')).toBe('0.1.1');
		expect(nextVersion('0.2.0-beta.1', 'fix')).toBe('0.2.0');
	});
});

describe('setVersion', () => {
	test('replaces the version line only', () => {
		expect(setVersion('name: a\nversion: 0.1.0\nx: y\n', '0.2.0')).toBe(
			'name: a\nversion: 0.2.0\nx: y\n',
		);
	});

	test('adds one under the name when there is none', () => {
		expect(setVersion('name: a\n', '0.1.0')).toBe('name: a\nversion: 0.1.0\n');
	});
});

describe('addChangelogEntry', () => {
	test('goes above the newest version, under any title', () => {
		expect(
			addChangelogEntry('# Changelog\n\n## 0.1.0\n\n- First version\n', '0.1.1', [
				'Fixes the card',
			]),
		).toBe('# Changelog\n\n## 0.1.1\n\n- Fixes the card\n\n## 0.1.0\n\n- First version\n');
	});

	test('starts a changelog that is empty', () => {
		expect(addChangelogEntry('', '0.1.0', ['First version'])).toBe('## 0.1.0\n\n- First version\n');
	});
});
