import { describe, expect, test } from 'bun:test';
import { codeOnly, type ExtensionEntry, isSwitchedOn, switchOff, switchOn } from './main-dart.ts';

const dashcam: ExtensionEntry = {
	packageName: 'smartify_os_dashcam',
	library: 'dashcam.dart',
	className: 'DashcamExtension',
	isConst: true,
};

const androidAuto = `import 'package:flutter/material.dart';
import 'package:smartify_os_android_auto/android_auto.dart';
import 'package:smartify_os_core/core.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SmartifyOs().init(
    // extensions: [const Nothing()],
    extensions: [const AndroidAutoExtension()],
  );
  runApp(const SmartifyOsApp());
}
`;

const multiline = `import 'package:smartify_os_core/core.dart';

Future<void> main() async {
  await SmartifyOs().init(
    extensions: [
      const AndroidAutoExtension(),
      MapsExtension(apiKey: 'a, b'), // mine
    ],
  );
}
`;

const noList = `import 'package:smartify_os_core/core.dart';

Future<void> main() async {
  await SmartifyOs().init(
    display: const DisplayConfig(),
  );
}
`;

describe('codeOnly', () => {
	test('blanks comments and strings but keeps every position', () => {
		const source = "a('x, y'); // extensions: [\nb(/* c */);";
		const code = codeOnly(source);
		expect(code.length).toBe(source.length);
		expect(code).not.toContain('extensions');
		expect(code).not.toContain('x, y');
		expect(code).toContain('b(');
	});
});

describe('switchOn', () => {
	test('adds to a list on one line, with its import in order', () => {
		const result = switchOn(androidAuto, dashcam);
		expect(result).toContain(
			'extensions: [const AndroidAutoExtension(), const DashcamExtension()],',
		);
		expect(result).toContain(
			"import 'package:smartify_os_core/core.dart';\nimport 'package:smartify_os_dashcam/dashcam.dart';\n",
		);
		// The commented out list is not the real one.
		expect(result).toContain('// extensions: [const Nothing()],');
	});

	test('adds a line of its own to a list over several lines', () => {
		const result = switchOn(multiline, dashcam);
		expect(result).toContain(
			"      MapsExtension(apiKey: 'a, b'), // mine\n      const DashcamExtension(),\n    ],",
		);
	});

	test('adds the list when the app has none yet', () => {
		const result = switchOn(noList, dashcam);
		expect(result).toContain(
			'    display: const DisplayConfig(),\n    extensions: [const DashcamExtension()],\n  );',
		);
	});

	test('fills an empty list', () => {
		const source = 'void main() { SmartifyOs().init(extensions: []); }';
		expect(switchOn(source, dashcam)).toContain('init(extensions: [const DashcamExtension()])');
	});

	test('leaves out const when the constructor cannot be const', () => {
		const result = switchOn(noList, { ...dashcam, isConst: false });
		expect(result).toContain('extensions: [DashcamExtension()],');
	});

	test('changes nothing when it is on already', () => {
		const on = switchOn(androidAuto, dashcam) ?? '';
		expect(switchOn(on, dashcam)).toBe(on);
	});

	test('gives up when there is no one clear place for it', () => {
		expect(switchOn('void main() {}', dashcam)).toBeUndefined();
		const twice = `${androidAuto}\nvoid other() { x(extensions: [a]); }`;
		expect(switchOn(twice, dashcam)).toBeUndefined();
	});
});

describe('switchOff', () => {
	test('takes an element and its import back out, leaving the file as it was', () => {
		for (const source of [androidAuto, multiline, noList]) {
			const on = switchOn(source, dashcam) ?? '';
			expect(isSwitchedOn(on, dashcam)).toBe(true);
			const off = switchOff(on, dashcam);
			expect(off).toBeDefined();
			expect(isSwitchedOn(off ?? '', dashcam)).toBe(false);
			expect(off).not.toContain('smartify_os_dashcam');
		}
	});

	test('takes out the only element on one line', () => {
		const androidAutoEntry: ExtensionEntry = {
			packageName: 'smartify_os_android_auto',
			library: 'android_auto.dart',
			className: 'AndroidAutoExtension',
			isConst: true,
		};
		const off = switchOff(androidAuto, androidAutoEntry) ?? '';
		expect(off).toContain('    extensions: [],\n');
		expect(off).not.toContain('android_auto.dart');
	});

	test('takes out a line of its own from a list over several lines', () => {
		const on = switchOn(multiline, dashcam) ?? '';
		expect(switchOff(on, dashcam)).toBe(multiline);
	});

	test('takes out the first of several on one line', () => {
		const source =
			"import 'package:smartify_os_dashcam/dashcam.dart';\nvoid main() { SmartifyOs().init(extensions: [const DashcamExtension(), const B()]); }\n";
		expect(switchOff(source, dashcam)).toBe(
			'void main() { SmartifyOs().init(extensions: [const B()]); }\n',
		);
	});

	test('gives up when the extension is used somewhere else too', () => {
		const source = `${switchOn(androidAuto, dashcam)}\nfinal other = DashcamExtension.id;\n`;
		expect(switchOff(source, dashcam)).toBeUndefined();
	});
});
