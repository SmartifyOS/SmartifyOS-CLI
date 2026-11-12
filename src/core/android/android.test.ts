import { describe, expect, test } from 'bun:test';
import { applicationIdIn } from './apk.ts';
import { mergeAndroid, parseAndroid } from './needs.ts';
import { withFullScreenThemes, withHomeScreen, withMinSdk, withPermissions } from './project.ts';
import { cmakeVersionsIn } from './sdk.ts';
import { componentsIn, deviceOwnerIn, ownerFailure } from './tablet.ts';
import { commandLineToolsArchive, javaMajor, missingAndroidTools } from './tools.ts';

const auto = { name: 'smartify_os_android_auto', title: 'Android Auto' };
const voice = { name: 'smartify_os_voice_assistant', title: 'Voice assistant' };
const core = { name: 'smartify_os_core', title: 'SmartifyOS' };

describe('parseAndroid', () => {
	test('reads minSdk and permissions, short names of Android own included', () => {
		const { lists, problems } = parseAndroid({
			android: { minSdk: 28, permissions: ['RECORD_AUDIO', 'android.permission.CAMERA'] },
		});
		expect(problems).toEqual([]);
		expect(lists).toEqual({
			minSdk: 28,
			permissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA'],
		});
	});

	test('reports mistakes and keys it does not know, and keeps the rest', () => {
		const { lists, problems } = parseAndroid({
			android: {
				minSdk: '28',
				permissions: ['record audio', 'android.permission.CAMERA'],
				icon: 'x',
			},
		});
		expect(lists.permissions).toEqual(['android.permission.CAMERA']);
		expect(problems.map((p) => [p.kind, p.path])).toEqual([
			['unknown', 'smartify_os.android.icon'],
			['invalid', 'smartify_os.android.minSdk'],
			['invalid', 'smartify_os.android.permissions[0]'],
		]);
	});

	test('a package without android: needs nothing', () => {
		expect(parseAndroid({ linux: {} })).toEqual({
			lists: { minSdk: undefined, permissions: [] },
			problems: [],
		});
	});
});

describe('mergeAndroid', () => {
	test('the highest minSdk wins, permissions add up with who asked', () => {
		const needs = mergeAndroid([
			{
				requester: core,
				lists: { minSdk: 24, permissions: ['android.permission.ACCESS_FINE_LOCATION'] },
				problems: [],
			},
			{
				requester: auto,
				lists: { minSdk: 28, permissions: ['android.permission.ACCESS_FINE_LOCATION'] },
				problems: [],
			},
			{
				requester: voice,
				lists: { minSdk: undefined, permissions: ['android.permission.RECORD_AUDIO'] },
				problems: [],
			},
		]);
		expect(needs.minSdk).toEqual({ level: 28, requesters: [auto] });
		expect(needs.permissions).toEqual([
			{ name: 'android.permission.ACCESS_FINE_LOCATION', requesters: [core, auto] },
			{ name: 'android.permission.RECORD_AUDIO', requesters: [voice] },
		]);
	});
});

const styles = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="LaunchTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">@drawable/launch_background</item>
    </style>
    <style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">
        <item name="android:windowBackground">?android:colorBackground</item>
    </style>
</resources>
`;

describe('withFullScreenThemes', () => {
	test('lets both themes use the strip beside a camera cutout, once', () => {
		const once = withFullScreenThemes(styles);
		expect(once.match(/windowLayoutInDisplayCutoutMode">shortEdges/g)).toHaveLength(2);
		expect(once).toContain(
			'    <style name="NormalTheme" parent="@android:style/Theme.Light.NoTitleBar">\n        <!-- SmartifyOS',
		);
		expect(withFullScreenThemes(once)).toBe(once);
	});
});

const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.CAMERA" />
    <application android:label="my_car">
    </application>
</manifest>
`;

describe('withPermissions', () => {
	const needs = {
		permissions: [
			{ name: 'android.permission.ACCESS_FINE_LOCATION', requesters: [core, auto] },
			{ name: 'android.permission.CAMERA', requesters: [core] },
			{ name: 'android.permission.RECORD_AUDIO', requesters: [voice] },
		],
	};

	test('writes the ones the owner has not in a block of its own, after <manifest>', () => {
		const text = withPermissions(manifest, needs);
		expect(text).toContain(
			'<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" /> <!-- SmartifyOS and Android Auto -->',
		);
		expect(text).toContain('android.permission.RECORD_AUDIO');
		expect(text.match(/android.permission.CAMERA/g)).toHaveLength(1);
		expect(text.indexOf('smartify-os: what')).toBeGreaterThan(text.indexOf('<manifest'));
		expect(withPermissions(text, needs)).toBe(text);
	});

	test('takes out what nothing asks for any more, and the block with the last one', () => {
		const text = withPermissions(manifest, needs);
		const fewer = withPermissions(text, { permissions: [needs.permissions[2] as never] });
		expect(fewer).not.toContain('ACCESS_FINE_LOCATION');
		expect(fewer).toContain('RECORD_AUDIO');
		expect(withPermissions(fewer, { permissions: [] })).toBe(manifest);
	});
});

describe('withMinSdk', () => {
	const kotlin = (line: string) =>
		`    defaultConfig {\n        ${line}\n        targetSdk = flutter.targetSdkVersion\n    }\n`;
	const needs = { minSdk: { level: 28, requesters: [auto] } };

	test("raises Flutter's own, and goes back to it once nothing asks", () => {
		const raised = withMinSdk(kotlin('minSdk = flutter.minSdkVersion'), needs, 'kotlin').text;
		expect(raised).toContain(
			'minSdk = maxOf(flutter.minSdkVersion, 28) // Written by smartify-os: what Android Auto needs.',
		);
		expect(withMinSdk(raised, needs, 'kotlin').text).toBe(raised);
		expect(withMinSdk(raised, { minSdk: null }, 'kotlin').text).toBe(
			kotlin('minSdk = flutter.minSdkVersion'),
		);
	});

	test("keeps the owner's own number when it is high enough, and raises it when not", () => {
		expect(withMinSdk(kotlin('minSdk = 30'), needs, 'kotlin').text).toBe(kotlin('minSdk = 30'));
		expect(withMinSdk(kotlin('minSdk = 26'), needs, 'kotlin').text).toContain(
			'maxOf(flutter.minSdkVersion, 28)',
		);
	});

	test('writes Groovy in an older app', () => {
		const groovy = '        minSdkVersion flutter.minSdkVersion\n';
		expect(withMinSdk(groovy, needs, 'groovy').text).toContain(
			'minSdkVersion Math.max(flutter.minSdkVersion, 28)',
		);
	});

	test('leaves code to the owner, saying what it has to be', () => {
		const result = withMinSdk(kotlin('minSdk = myMinSdk()'), needs, 'kotlin');
		expect(result.text).toBe(kotlin('minSdk = myMinSdk()'));
		expect(result.manual).toContain('at least 28');
	});
});

describe('cmakeVersionsIn', () => {
	test('finds the versions cmake blocks pin, in Groovy and Kotlin', () => {
		const groovy = `android {
    defaultConfig {
        externalNativeBuild {
            cmake {
                cppFlags '-std=c++14'
                version "3.31.4"
            }
        }
    }
    externalNativeBuild { cmake { path "CMakeLists.txt"; version "3.31.4" } }
}`;
		expect(cmakeVersionsIn(groovy)).toEqual(['3.31.4']);
		expect(cmakeVersionsIn('externalNativeBuild { cmake { version = "3.22.1" } }')).toEqual([
			'3.22.1',
		]);
		expect(cmakeVersionsIn('android { compileSdk = 35 }\nversion = "1.0"')).toEqual([]);
		expect(
			cmakeVersionsIn('cmake {\n    path "x"\n    // version "3.10.2"\n    /* version "3.9" */\n}'),
		).toEqual([]);
	});
});

describe('javaMajor', () => {
	test('reads the major version of every way Java says it', () => {
		expect(javaMajor('openjdk version "21.0.8" 2025-07-15')).toBe(21);
		expect(javaMajor('java version "1.8.0_401"')).toBe(8);
		expect(javaMajor('openjdk version "17" 2021-09-14')).toBe(17);
		expect(javaMajor('command not found')).toBeUndefined();
	});
});

describe('commandLineToolsArchive', () => {
	const repository = `
  <remotePackage path="cmdline-tools;latest">
    <archives>
      <archive><complete><checksum type="sha1">aaa</checksum><url>commandlinetools-linux-1_latest.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><checksum type="sha1">bbb</checksum><url>commandlinetools-mac_x86_64-1_latest.zip</url></complete><host-os>macosx</host-os><host-arch>x64</host-arch></archive>
      <archive><complete><checksum type="sha1">ccc</checksum><url>commandlinetools-mac_arm64-1_latest.zip</url></complete><host-os>macosx</host-os><host-arch>aarch64</host-arch></archive>
      <archive><complete><checksum type="sha1">ddd</checksum><url>commandlinetools-win-1_latest.zip</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="cmdline-tools;2.0"><archives><archive><complete><checksum type="sha1">old</checksum><url>old.zip</url></complete><host-os>linux</host-os></archive></archives></remotePackage>`;

	test("picks this computer's zip of the newest, with its checksum", () => {
		expect(commandLineToolsArchive(repository, 'darwin', 'arm64')).toEqual({
			url: 'https://dl.google.com/android/repository/commandlinetools-mac_arm64-1_latest.zip',
			sha1: 'ccc',
		});
		expect(commandLineToolsArchive(repository, 'darwin', 'x64')?.sha1).toBe('bbb');
		expect(commandLineToolsArchive(repository, 'linux', 'arm64')?.sha1).toBe('aaa');
		expect(commandLineToolsArchive(repository, 'win32', 'x64')?.sha1).toBe('ddd');
		expect(commandLineToolsArchive('<nothing/>')).toBeUndefined();
	});
});

describe('missingAndroidTools', () => {
	const ready = {
		sdk: '/sdk',
		sdkmanager: '/sdk/cmdline-tools/latest/bin/sdkmanager',
		adb: '/sdk/platform-tools/adb',
		licences: true,
		java: { home: '/jdk', version: 21 },
		flutter: {},
	};

	test('names every piece that is missing, an old Java too', () => {
		expect(missingAndroidTools(ready)).toEqual([]);
		expect(missingAndroidTools({ ...ready, sdkmanager: undefined, licences: false })).toEqual([
			"the SDK's command line tools",
			"the SDK's licence, accepted",
		]);
		expect(
			missingAndroidTools({ ...ready, sdk: undefined, java: { home: '/jdk', version: 11 } }),
		).toEqual(['the Android SDK', 'Java 17 or newer']);
	});
});

const flutterManifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="my_car">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

describe('withHomeScreen', () => {
	test('lets MainActivity be the home screen, right after the launcher filter, once', () => {
		const once = withHomeScreen(flutterManifest);
		expect(once).toContain(
			[
				'                <category android:name="android.intent.category.LAUNCHER"/>',
				'            </intent-filter>',
				"            <!-- smartify-os: lets SmartifyOS be the tablet's home screen, which it starts into",
			].join('\n'),
		);
		expect(once).toContain(
			[
				'            <intent-filter>',
				'                <action android:name="android.intent.action.MAIN" />',
				'                <category android:name="android.intent.category.HOME" />',
				'                <category android:name="android.intent.category.DEFAULT" />',
				'            </intent-filter>',
				'        </activity>',
			].join('\n'),
		);
		expect(withHomeScreen(once ?? '')).toBe(once);
	});

	test('leaves a manifest without a launcher filter to the owner', () => {
		expect(withHomeScreen('<manifest>\n</manifest>\n')).toBeUndefined();
	});
});

describe('applicationIdIn', () => {
	test('reads Kotlin and Groovy, and nothing written as code', () => {
		expect(applicationIdIn('    applicationId = "com.example.my_car"\n')).toBe(
			'com.example.my_car',
		);
		expect(applicationIdIn("        applicationId 'dev.my_car'\n")).toBe('dev.my_car');
		expect(applicationIdIn('        applicationId = ids.car\n')).toBeUndefined();
	});
});

describe('the tablet', () => {
	test('reads activities from query-activities and resolve-activity', () => {
		expect(componentsIn('No activities found\n')).toEqual([]);
		expect(
			componentsIn(
				'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.launcher3/.uioverrides.QuickstepLauncher\n',
			),
		).toEqual(['com.android.launcher3/.uioverrides.QuickstepLauncher']);
	});

	test('reads the device owner from dumpsys and list-owners', () => {
		expect(deviceOwnerIn('Current Device Policy Manager state:\n  Enabled Device Admins:\n')).toBe(
			undefined,
		);
		expect(
			deviceOwnerIn(
				'  Device Owner: \n    admin=ComponentInfo{com.example.my_car/dev.smartify_os.core.SmartifyOsDeviceAdmin}\n    name=\n',
			),
		).toBe('com.example.my_car');
		expect(
			deviceOwnerIn(
				'User 0: admin=com.example.my_car/dev.smartify_os.core.SmartifyOsDeviceAdmin,DeviceOwner',
			),
		).toBe('com.example.my_car');
	});

	test('says plainly why it could not become the owner', () => {
		const accounts = ownerFailure(
			"Exception occurred while executing 'set-device-owner':\njava.lang.IllegalStateException: Not allowed to set the device owner because there are already some accounts on the device.\n\tat com.android.server...",
		);
		expect(accounts.message).toContain('account');
		expect(accounts.hint).toContain('factory settings');
		expect(
			ownerFailure(
				'java.lang.IllegalStateException: Trying to set the device owner (a/b), but device owner (c/d) is already set.',
			).message,
		).toBe('Another app is already the owner of this tablet.');
		expect(
			ownerFailure('Not allowed to set the device owner because the device is already provisioned')
				.hint,
		).toContain('account');
		expect(
			ownerFailure('java.lang.IllegalArgumentException: Unknown admin: ComponentInfo{a/b}').hint,
		).toContain('--install');
		expect(ownerFailure('java.lang.SecurityException: something new').hint).toBe('something new');
	});
});
