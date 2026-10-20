import { describe, expect, test } from 'bun:test';
import {
	assetPath,
	drawingNames,
	modelNames,
	readAppearance,
	setAppearance,
} from './appearance.ts';

const main = `import 'package:flutter/material.dart';
import 'package:smartify_os_core/core.dart';
import 'package:smartify_os_core/layouts.dart';
import 'package:smartify_os_core/settings.dart';

Future<void> main() async {
  await SmartifyOs().init(
    settings: const SettingsConfig(about: AboutConfig(deviceName: 'My car')),
    layouts: const LayoutsConfig(
      // layout: Layouts.split,
      driverSide: DriverSide.left,
    ),
    car: const CarConfig(
      model3D: CarModel3DConfig(path: 'assets/car.glb', scale: 0.7),

      // Which one the car starts with.
      // look: CarLook.drawing2D,
    ),
    extensions: [],
  );
}
`;

describe('readAppearance', () => {
	test('reads what is written, and the defaults for what is not', () => {
		const appearance = readAppearance(main);
		expect(appearance.layout).toBe('classic');
		expect(appearance.theme).toBeNull();
		expect(appearance.driverSide).toBe('left');
		expect(appearance.bar).toBe('infoDisplay');
		expect(appearance.car).toEqual({
			model3D: 'assets/car.glb',
			drawing2D: null,
			image: null,
			look: null,
		});
		expect(appearance.about).toEqual({ name: 'My car', model: null, extra: {} });
		expect(appearance.code).toEqual({});
	});

	test('reports what is written as code instead of guessing', () => {
		const source = main
			.replace('// layout: Layouts.split,', 'layout: miataRoadsterLayout,')
			.replace("about: AboutConfig(deviceName: 'My car')", 'about: miataAbout');
		const appearance = readAppearance(source);
		expect(appearance.layout).toBeNull();
		expect(appearance.code.layout).toBe('miataRoadsterLayout');
		expect(appearance.about.name).toBeNull();
		expect(appearance.code.name).toBe('miataAbout');
	});

	test('reads layouts and themes given as strings, and rows of the About page', () => {
		const source = main
			.replace('// layout: Layouts.split,', "layout: 'miata_roadster',")
			.replace("deviceName: 'My car'", "deviceName: 'Golf', extra: {'VIN': 'X1', 'Colour': 'Red'}");
		const appearance = readAppearance(source);
		expect(appearance.layout).toBe('miata_roadster');
		expect(appearance.about.extra).toEqual({ VIN: 'X1', Colour: 'Red' });
	});
});

describe('setAppearance', () => {
	test('takes the slashes off an example the owner left commented out', () => {
		const { source, manual } = setAppearance(main, { layout: 'split', look: 'drawing2D' });
		expect(manual).toEqual([]);
		expect(source).toContain('      layout: Layouts.split,\n      driverSide');
		expect(source).toContain('      look: CarLook.drawing2D,\n');
		expect(source).not.toContain('// look:');
	});

	test('adds a config that is not there, with its import', () => {
		const { source } = setAppearance(main, { theme: 'frost', bar: 'dock' });
		expect(source).toContain('themes: const ThemesConfig(theme: Themes.frost),');
		expect(source).toContain('bar: const BarConfig(content: BarContent.dock()),');
		expect(source).toContain("import 'package:smartify_os_core/theme.dart';");
		expect(readAppearance(source).theme).toBe('frost');
	});

	test("names a car's own layout in quotes", () => {
		const { source } = setAppearance(main, { layout: 'miata_roadster' });
		expect(source).toContain("layout: 'miata_roadster',");
	});

	test('takes a picture of the car out, with the comment about it', () => {
		const { source } = setAppearance(main, { model3D: null, drawing2D: 'assets/car.svg' });
		expect(source).not.toContain('model3D');
		expect(readAppearance(source).car.drawing2D).toBe('assets/car.svg');
	});

	test('changes rows of the About page one by one', () => {
		const first = setAppearance(main, { extra: { VIN: 'X1', Colour: 'Red' } }).source;
		const second = setAppearance(first, { extra: { Colour: '' }, model: 'VW Golf' }).source;
		expect(readAppearance(second).about).toEqual({
			name: 'My car',
			model: 'VW Golf',
			extra: { VIN: 'X1' },
		});
	});

	test('hands back what cannot be placed', () => {
		const source = main.replace('layouts: const LayoutsConfig(', 'layouts: myLayouts(');
		const { manual } = setAppearance(source, { layout: 'split' });
		expect(manual).toEqual(['layout: Layouts.split in LayoutsConfig(...)']);
	});
});

describe('assetPath', () => {
	test('keeps a file already in the app where it is', () => {
		expect(assetPath('/cars/golf', '/cars/golf/assets/golf.glb')).toEqual({
			asset: 'assets/golf.glb',
			copy: false,
		});
	});

	test('copies anything else into assets, with a name that works there', () => {
		expect(assetPath('/cars/golf', '/Users/me/Downloads/My Golf.GLB')).toEqual({
			asset: 'assets/my_golf.glb',
			copy: true,
		});
	});
});

describe('part names', () => {
	test('reads the objects of a binary glTF model', () => {
		const json = new TextEncoder().encode(
			JSON.stringify({
				nodes: [{ name: 'Body' }, { name: 'LeftFrontWheel' }, {}, { name: 'Body' }],
			}),
		);
		const bytes = new Uint8Array(20 + json.length);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, 0x46546c67, true);
		view.setUint32(4, 2, true);
		view.setUint32(8, bytes.length, true);
		view.setUint32(12, json.length, true);
		view.setUint32(16, 0x4e4f534a, true);
		bytes.set(json, 20);
		expect(modelNames(bytes)).toEqual(['Body', 'LeftFrontWheel']);
	});

	test('reads the named groups of a drawing, not the pivots', () => {
		const svg = `<svg><g id="Layer1"><g id='LeftDoor'><circle id="LeftDoor_pivot"/></g><g id="FrontLeftWheel"><g id="pivot"/></g></g></svg>`;
		expect(drawingNames(svg)).toEqual(['Layer1', 'LeftDoor', 'FrontLeftWheel']);
	});
});
