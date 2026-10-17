import { describe, expect, test } from 'bun:test';
import { CliError } from '../../utils/errors.ts';
import { parsePubspec } from '../pubspec/read.ts';
import type { CoreAt } from '../smartify-os.ts';
import {
	type CarSetup,
	carNames,
	dartString,
	finishAppPubspec,
	isTimeZone,
	lookAsset,
	renameCarText,
	setUpMain,
} from './create.ts';
import { setArgument, switchOn } from './main-dart.ts';

/** The template's lib/main.dart, as smartify_os_app_template has it. */
const templateMain = `import 'package:flutter/material.dart';
import 'package:smartify_os_core/app_list.dart';
import 'package:smartify_os_core/bluetooth.dart';
import 'package:smartify_os_core/core.dart';
import 'package:smartify_os_core/date_time.dart';
import 'package:smartify_os_core/layouts.dart';
import 'package:smartify_os_core/settings.dart';

/// The SmartifyOS app of My car.
///
/// Everything about the car is set up in \`SmartifyOs().init(...)\` below. The
/// Miata app in the SmartifyOS repository is a complete example of a car with
/// everything in it (its own settings, home widgets, quick settings, the CAN
/// bus and a knob to drive it all), to copy from whenever you want more.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await SmartifyOs().init(
    // The name phones see when they pair with the car.
    bluetooth: const BluetoothConfig(name: 'My car'),

    // What the About page in Settings says about the car.
    settings: const SettingsConfig(about: AboutConfig(deviceName: 'My car')),

    // How the screen is arranged. The driver can switch to any layout in
    // Settings, Appearance, and SmartifyOS remembers it.
    layouts: const LayoutsConfig(
      // The layout the car starts with. The others are Layouts.classic,
      // Layouts.split, Layouts.sidebar, Layouts.tiles, Layouts.focus and
      // Layouts.portrait (for a screen standing upright).
      layout: Layouts.classic,

      // Which side the driver sits on. Every layout puts what the driver
      // reaches for on this side.
      driverSide: DriverSide.left,
    ),

    // What sits in the bar, the same in every layout: the info display
    // (BarContent.infoDisplay()), a dock of apps (BarContent.dock()), or
    // both (BarContent.infoDisplayAndDock()).
    bar: const BarConfig(
      content: BarContent.infoDisplay(),

      // The apps in the dock, until the driver changes them by holding an
      // app in the app list.
      dockApps: [AppListEntries.settings],
    ),

    // The time zone the car starts out in. Whatever the driver picks on the
    // Date & time settings page wins after that.
    dateTime: const DateTimeConfig(),

    // Features from packages of their own. \`smartify-os extension add\`
    // puts them in here for you.
    extensions: [],
  );

  runApp(const SmartifyOsApp());
}
`;

/** The template's pubspec.yaml. */
const templatePubspec = `name: smartify_os_my_car_app
description: "The SmartifyOS app of My car."
publish_to: none
version: 0.1.0+1

environment:
  sdk: ^3.10.3
  flutter: ">=3.38.0"

dependencies:
  flutter:
    sdk: flutter
  smartify_os_core: any

# Where SmartifyOS and every extension come from. The smartify-os CLI writes
# this for you (\`smartify-os update\`, \`smartify-os extension add\`), so you
# never have to.
dependency_overrides:
  smartify_os_core:
    path: ../smartify_os_core
  flutter_angle: # SmartifyOS needs this too, smartify-os keeps it in step
    git:
      url: https://github.com/Mauznemo/flutter_angle.git
      ref: b6d66855924bb620e6b380648a0b4f9be4935b43

dev_dependencies:
  flutter_lints: ^6.0.0

flutter:
  uses-material-design: true
`;

const core: CoreAt = {
	source: { url: 'https://example.com/smartify_os.git', path: 'smartify_os_core', ref: 'v0.3.0' },
	version: '0.3.0',
	pubspecText: `name: smartify_os_core
dependency_overrides:
  flutter_angle:
    git:
      url: https://example.com/flutter_angle.git
      ref: abc123
`,
};

const plain: CarSetup = {
	layout: 'classic',
	driverSide: 'left',
	bar: 'infoDisplay',
	timeZone: 'Europe/Berlin',
	looks: {},
	reverseCamera: false,
};

describe('carNames', () => {
	test('gives every spelling of a name', () => {
		expect(carNames('Miata')).toEqual({
			name: 'Miata',
			snake: 'miata',
			packageName: 'smartify_os_miata_app',
		});
	});

	test('takes digits, dashes and letters with accents', () => {
		expect(carNames('  Golf   4 ').snake).toBe('golf_4');
		expect(carNames('MX-5').snake).toBe('mx_5');
		expect(carNames('2CV').packageName).toBe('smartify_os_2cv_app');
		expect(carNames('Käfer').snake).toBe('kafer');
	});

	test('refuses what would break the code it goes into', () => {
		for (const name of ['', "Dad's car", 'My "car"', 'Car $1', 'a\\b', '-car', 'x'.repeat(41)]) {
			expect(() => carNames(name)).toThrow(CliError);
		}
	});
});

describe('renameCarText', () => {
	test('replaces both spellings the template uses', () => {
		expect(
			renameCarText(
				"import 'package:smartify_os_my_car_app/x.dart'; // My car",
				carNames('Golf 4'),
			),
		).toBe("import 'package:smartify_os_golf_4_app/x.dart'; // Golf 4");
	});
});

describe('dartString', () => {
	test('escapes what Dart reads differently', () => {
		expect(dartString('Cost $5 \\')).toBe("'Cost \\$5 \\\\'");
		expect(dartString(`It's "fast"`)).toBe("'It\\'s \"fast\"'");
	});

	test('takes double quotes for an apostrophe, so it needs no backslash', () => {
		expect(dartString("O'Brien's $5")).toBe('"O\'Brien\'s \\$5"');
	});
});

describe('isTimeZone', () => {
	test('knows the standard names', () => {
		expect(isTimeZone('Europe/Berlin')).toBe(true);
		expect(isTimeZone('UTC')).toBe(true);
		expect(isTimeZone('Mars/Olympus')).toBe(false);
		expect(isTimeZone('')).toBe(false);
	});
});

describe('lookAsset', () => {
	test('names the file after the car', () => {
		const names = carNames('Golf 4');
		expect(lookAsset(names, 'model3D', '/x/Car.GLB')).toBe('assets/golf_4_model.glb');
		expect(lookAsset(names, 'drawing2D', '/x/top.svg')).toBe('assets/golf_4_drawing.svg');
		expect(lookAsset(names, 'image', '/x/photo.jpg')).toBe('assets/golf_4.jpg');
	});
});

describe('setArgument', () => {
	const source = `void main() {
  run(
    // first
    a: 1,

    // the list
    extensions: [],
  );
  other(a: 1);
}
`;

	test('replaces an argument that is there', () => {
		expect(setArgument(source, /\brun\s*\(/, 'a', '2')).toContain('    a: 2,\n');
	});

	test('adds one in front of another, above its comment', () => {
		const result = setArgument(source, /\brun\s*\(/, 'b', 'true', {
			before: 'extensions',
			comment: ['b is new'],
		});
		expect(result).toContain(
			'    a: 1,\n\n    // b is new\n    b: true,\n\n    // the list\n    extensions: [],',
		);
	});

	test('adds one at the end when there is nothing to go in front of', () => {
		expect(setArgument(source, /\bother\s*\(/, 'b', '2')).toContain('other(a: 1, b: 2);');
	});

	test('gives up on a call that is not there exactly once', () => {
		expect(setArgument(source, /\bmissing\s*\(/, 'b', '2')).toBeUndefined();
		expect(setArgument(`${source}${source}`, /\brun\s*\(/, 'b', '2')).toBeUndefined();
	});
});

describe('setUpMain', () => {
	test('writes every answer into the template', () => {
		const { source, manual } = setUpMain(templateMain, {
			model: "Mazda MX-5 NB 1.8 'Sport'",
			layout: 'split',
			driverSide: 'right',
			bar: 'infoDisplayAndDock',
			timeZone: 'Asia/Tokyo',
			looks: { model3D: 'assets/miata_model.glb', image: 'assets/miata.png' },
			reverseCamera: true,
		});

		expect(manual).toEqual([]);
		expect(source).toContain('layout: Layouts.split,');
		expect(source).toContain('driverSide: DriverSide.right,');
		expect(source).toContain('content: BarContent.infoDisplayAndDock(),');
		expect(source).toContain("DateTimeConfig(timeZone: 'Asia/Tokyo')");
		expect(source).toContain(
			"AboutConfig(deviceName: 'My car', model: \"Mazda MX-5 NB 1.8 'Sport'\")",
		);
		expect(source).toContain(
			"car: const CarConfig(model3D: CarModel3DConfig(path: 'assets/miata_model.glb'), image: CarImageConfig(path: 'assets/miata.png')),",
		);
		expect(source).toContain('reverseCamera: const ReverseCameraConfig(),');
		expect(source).toContain("import 'package:smartify_os_core/car.dart';");
		expect(source).toContain("import 'package:smartify_os_core/reverse_camera.dart';");
		// In front of the extensions, which stay where `extension add` finds them.
		expect(source.indexOf('reverseCamera:')).toBeLessThan(source.indexOf('// Features from'));
		expect(
			switchOn(source, {
				packageName: 'smartify_os_dashcam',
				library: 'dashcam.dart',
				className: 'DashcamExtension',
				isConst: true,
			}),
		).toContain('extensions: [const DashcamExtension()],');
	});

	test('leaves out what was not answered', () => {
		const { source } = setUpMain(templateMain, plain);
		expect(source).not.toContain('model:');
		expect(source).not.toContain('CarConfig');
		expect(source).not.toContain('ReverseCameraConfig');
	});

	test('names what it could not write, rather than failing', () => {
		const { manual } = setUpMain(templateMain.replace('const DateTimeConfig()', 'null'), plain);
		expect(manual).toEqual(["timeZone: 'Europe/Berlin' in DateTimeConfig(...)"]);
	});
});

describe('finishAppPubspec', () => {
	test('points the template at SmartifyOS and adds the pictures', () => {
		const text = finishAppPubspec(templatePubspec, core, ['assets/golf_4_model.glb']);
		const pubspec = parsePubspec(text, 'pubspec.yaml');
		expect(pubspec.dependencies?.smartify_os_core).toBe('any');
		expect(pubspec.dependency_overrides).toEqual({
			smartify_os_core: { git: { url: core.source.url, path: 'smartify_os_core', ref: 'v0.3.0' } },
			flutter_angle: { git: { url: 'https://example.com/flutter_angle.git', ref: 'abc123' } },
		});
		expect(pubspec.flutter).toEqual({
			'uses-material-design': true,
			assets: ['assets/golf_4_model.glb'],
		});
		// The comment above the overrides is the template's, and stays.
		expect(text).toContain('# Where SmartifyOS and every extension come from.');
	});

	test('moves an extension the Miata app names by git to the overrides', () => {
		const miata = `name: smartify_os_miata_app
dependencies:
  flutter:
    sdk: flutter
  smartify_os_core:
    path: ../smartify_os_core
  smartify_os_android_auto:
    git:
      url: https://github.com/Mauznemo/smartify_os_android_auto.git
      ref: f01bef

dependency_overrides:
  smartify_os_core:
    path: ../smartify_os_core

flutter:
  assets:
    - assets/miata_model.glb
`;
		const pubspec = parsePubspec(finishAppPubspec(miata, core), 'pubspec.yaml');
		expect(pubspec.dependencies?.smartify_os_android_auto).toBe('any');
		expect(pubspec.dependency_overrides?.smartify_os_android_auto).toEqual({
			git: { url: 'https://github.com/Mauznemo/smartify_os_android_auto.git', ref: 'f01bef' },
		});
		expect(pubspec.flutter).toEqual({ assets: ['assets/miata_model.glb'] });
	});
});
