import { describe, expect, test } from 'bun:test';
import { parsePubspec } from '../pubspec/read.ts';
import {
	markedOverrides,
	neededMarker,
	withCore,
	withExtension,
	withoutExtension,
} from './block.ts';
import { ignoreOverrides, readLinks, renderOverrides } from './links.ts';

/** A car's app the way someone set it up by hand, before the CLI ever touched it. */
const handWritten = `name: my_car
publish_to: 'none'

dependencies:
  flutter:
    sdk: flutter
  smartify_os_core:
    path: ../smartify_os_core

# How SmartifyOS itself is found.
dependency_overrides:
  smartify_os_core:
    path: ../smartify_os_core
  # Keep in step with smartify_os_core/pubspec.yaml.
  flutter_angle:
    git:
      url: https://github.com/Mauznemo/flutter_angle.git
      ref: main

flutter:
  uses-material-design: true
`;

const core = {
	url: 'https://github.com/Mauznemo/core.git',
	path: 'smartify_os_core',
	ref: 'v0.3.0',
};

const angle = {
	name: 'flutter_angle',
	lines: [
		'flutter_angle:',
		'  git:',
		'    url: https://github.com/Mauznemo/flutter_angle.git',
		'    ref: main',
	],
};

describe('withCore', () => {
	test('turns a hand written app into the block the CLI owns', () => {
		const result = withCore(handWritten, core, [angle], ['flutter_angle']);
		const pubspec = parsePubspec(result, 'test');

		expect(pubspec.dependencies?.smartify_os_core).toBe('any');
		expect(pubspec.dependency_overrides?.smartify_os_core).toEqual({
			git: { url: core.url, path: 'smartify_os_core', ref: 'v0.3.0' },
		});
		expect(pubspec.dependency_overrides?.flutter_angle).toEqual({
			git: { url: 'https://github.com/Mauznemo/flutter_angle.git', ref: 'main' },
		});
		expect(markedOverrides(result)).toEqual(['flutter_angle']);
		// The owner's own comment about the section is still there.
		expect(result).toContain('# How SmartifyOS itself is found.');
	});

	test('replaces the overrides the old SmartifyOS needed with the new ones', () => {
		const first = withCore(handWritten, core, [angle], ['flutter_angle']);
		const http = { name: 'http', lines: ['http: ^1.0.0'] };
		const second = withCore(first, { ...core, ref: 'v0.4.0' }, [http]);
		const pubspec = parsePubspec(second, 'test');

		expect(pubspec.dependency_overrides?.flutter_angle).toBeUndefined();
		expect(pubspec.dependency_overrides?.http).toBe('^1.0.0');
		expect(second).toContain(`http: ^1.0.0 ${neededMarker}`);
		expect(second).toContain('ref: v0.4.0');
	});

	test('does the same thing twice without piling anything up', () => {
		const once = withCore(handWritten, core, [angle], ['flutter_angle']);
		expect(withCore(once, core, [angle])).toBe(once);
	});

	test('never takes out an override of the owner that SmartifyOS never needed', () => {
		const own = handWritten.replace(
			'dependency_overrides:\n',
			'dependency_overrides:\n  mine: ^2.0.0\n',
		);
		const result = withCore(own, core, [angle], ['flutter_angle']);
		expect(parsePubspec(result, 'test').dependency_overrides?.mine).toBe('^2.0.0');
	});
});

describe('withExtension and withoutExtension', () => {
	const car = withCore(handWritten, core, [angle], ['flutter_angle']);
	const dashcam = { url: 'https://github.com/someone/smartify_os_dashcam.git', ref: 'v0.1.0' };

	test('adds it to both sections', () => {
		const pubspec = parsePubspec(withExtension(car, 'smartify_os_dashcam', dashcam), 'test');
		expect(pubspec.dependencies?.smartify_os_dashcam).toBe('any');
		expect(pubspec.dependency_overrides?.smartify_os_dashcam).toEqual({
			git: { url: dashcam.url, ref: 'v0.1.0' },
		});
	});

	test('moves it to another ref in place', () => {
		const added = withExtension(car, 'smartify_os_dashcam', dashcam);
		const moved = withExtension(added, 'smartify_os_dashcam', { ...dashcam, ref: 'v0.2.0' });
		expect(moved).toBe(added.replace('ref: v0.1.0', 'ref: v0.2.0'));
	});

	test('taking it out leaves the file as it was', () => {
		const added = withExtension(car, 'smartify_os_dashcam', dashcam);
		expect(withoutExtension(added, 'smartify_os_dashcam')).toBe(car);
	});
});

describe('renderOverrides', () => {
	const car = withExtension(
		withCore(handWritten, core, [angle], ['flutter_angle']),
		'smartify_os_dashcam',
		{ url: 'https://github.com/someone/smartify_os_dashcam.git', ref: 'v0.1.0' },
	);

	test('repeats every override and swaps the linked ones for their folder', () => {
		const links = new Map([['smartify_os_dashcam', '../smartify_os_dashcam']]);
		const text = renderOverrides(car, links);
		const overrides = parsePubspec(text, 'test').dependency_overrides;

		expect(overrides?.smartify_os_dashcam).toEqual({ path: '../smartify_os_dashcam' });
		expect(overrides?.smartify_os_core).toEqual({
			git: { url: core.url, path: 'smartify_os_core', ref: 'v0.3.0' },
		});
		expect(overrides?.flutter_angle).toBeDefined();
		expect(readLinks(text)).toEqual(links);
	});

	test('adds a linked extension that is not installed from anywhere', () => {
		const links = new Map([['smartify_os_new', '../smartify_os_new']]);
		expect(readLinks(renderOverrides(car, links))).toEqual(links);
	});
});

describe('ignoreOverrides', () => {
	test('adds the file to .gitignore once', () => {
		const added = ignoreOverrides('build/\n') ?? '';
		expect(added).toContain('build/\n\n');
		expect(added).toContain('/pubspec_overrides.yaml\n');
		expect(ignoreOverrides(added)).toBeUndefined();
	});

	test('counts it as listed however it is written', () => {
		expect(ignoreOverrides('pubspec_overrides.yaml')).toBeUndefined();
		expect(ignoreOverrides('**/pubspec_overrides.yaml\n')).toBeUndefined();
	});

	test('starts a .gitignore when there is none', () => {
		expect(ignoreOverrides(undefined)?.startsWith('# Folders')).toBe(true);
	});
});
