import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToConfig, addToInit, deviceCall } from './app.ts';
import type { BuiltFirmware } from './build.ts';
import { compilerErrors, readPartitions } from './build.ts';
import { cppName, type FirmwareSource, parseFirmwareSource, parseNodes } from './network.ts';
import {
	boardId,
	codeHash,
	createDevice,
	deviceName,
	listDevices,
	parseSettings,
	raiseVersion,
	readDevice,
	renderIni,
	syncIni,
	versionMacro,
} from './project.ts';
import { renderDeviceConf, writeDeviceFirmware } from './stick.ts';

const dir = await mkdtemp(join(tmpdir(), 'smartify-os-device-'));

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const firmware: FirmwareSource = {
	library: 'https://github.com/SmartifyOS/SmartifyOS-ESP32.git',
	version: 'v0.1.0',
	platform: 'espressif32@7.1.3',
};

const header = `#pragma once
namespace network {

/// Every device on the bus. Pass yours to SmartifyOsCan.begin.
namespace nodes {
/// Buttons
constexpr uint8_t buttons = 1;
/// Pop-up headlights
constexpr uint8_t headlights = 2;
}  // namespace nodes

struct HeadlightsState {
  static constexpr uint32_t id = 0x200;
};
}  // namespace network
`;

describe('the header SmartifyOS writes', () => {
	test('lists every device with its node and title', () => {
		expect(parseNodes(header)).toEqual([
			{ name: 'buttons', node: 1, title: 'Buttons' },
			{ name: 'headlights', node: 2, title: 'Pop-up headlights' },
		]);
		expect(parseNodes('#pragma once\n')).toEqual([]);
	});

	test("makes a device's name a C++ name the way SmartifyOS does", () => {
		expect(cppName('headlights')).toBe('headlights');
		expect(cppName('front-lights')).toBe('front_lights');
		expect(cppName('2nd')).toBe('_2nd');
	});
});

describe('what SmartifyOS builds firmware with', () => {
	test("is read from smartify_os: firmware: in SmartifyOS's pubspec", () => {
		const text = `name: smartify_os_core
smartify_os:
  linux:
    run:
      groups: [dialout]
  firmware:
    library: https://github.com/SmartifyOS/SmartifyOS-ESP32.git
    version: v0.1.0
    platform: espressif32@7.1.3
`;
		expect(parseFirmwareSource(text)).toEqual(firmware);
		expect(parseFirmwareSource('name: smartify_os_core\n')).toBeUndefined();
	});
});

describe('a device project', () => {
	test('is made with the default partition table, the library and the header', async () => {
		const ini = renderIni({ name: 'headlights', title: 'Headlights', board: 'esp32dev' }, firmware);
		expect(ini).toContain('[env:headlights]\n');
		expect(ini).toContain('platform = espressif32@7.1.3\n');
		expect(ini).toContain('framework = arduino\n');
		expect(ini).toContain('board = esp32dev\n');
		expect(ini).toContain('\thttps://github.com/SmartifyOS/SmartifyOS-ESP32.git#v0.1.0\n');
		expect(ini).toContain('build_flags =\n');
		expect(ini).toContain('\t-I ../../firmware\n');
		expect(ini).not.toContain('partitions');
	});

	test('is written into devices/<name>, and found again', async () => {
		const app = join(dir, 'car');
		const made = await createDevice(
			app,
			{ name: 'headlights', title: 'Headlights', board: 'esp32dev', device: 'headlights' },
			firmware,
		);
		expect(made.dir).toBe(join(app, 'devices', 'headlights'));
		expect(made.files.sort()).toEqual([
			'.gitignore',
			'platformio.ini',
			'smartify-os.json',
			join('src', 'main.cpp'),
		]);
		const main = await Bun.file(join(made.dir, 'src', 'main.cpp')).text();
		expect(main).toContain('SmartifyOsCan.begin(network::nodes::headlights, canTx, canRx);');
		expect(main).toContain('SmartifyOsCan.update();');
		expect(await Bun.file(join(made.dir, '.gitignore')).text()).toContain('.pio/');

		const found = await listDevices(app);
		expect(found.map((d) => [d.settings, d.env, d.board])).toEqual([
			[{ device: 'headlights', version: '1.0.0', code: null }, 'headlights', 'esp32dev'],
		]);
		await expect(
			createDevice(
				app,
				{ name: 'headlights', title: 'Headlights', board: 'esp32dev', device: 'headlights' },
				firmware,
			),
		).rejects.toThrow('already');
	});

	test('notices a change to its code or to the header, and nothing else', async () => {
		const app = join(dir, 'car-hash');
		const made = await createDevice(
			app,
			{ name: 'lights', title: 'Lights', board: 'esp32dev', device: 'lights' },
			firmware,
		);
		await Bun.write(join(app, 'firmware', 'smartify_os_network.h'), header);
		const device = (await readDevice(made.dir)) ?? expect.unreachable();
		const first = await codeHash(device, app);

		await Bun.write(join(made.dir, '.pio', 'build', 'x.o'), 'built');
		await Bun.write(
			join(made.dir, 'smartify-os.json'),
			'{"device":"lights","version":"2.0.0","code":"x"}',
		);
		expect(await codeHash(device, app)).toBe(first);

		const main = join(made.dir, 'src', 'main.cpp');
		const text = await Bun.file(main).text();
		await Bun.write(main, text.replace(/\n/g, '\r\n'));
		expect(await codeHash(device, app)).toBe(first);

		await Bun.write(main, `${text}// more\n`);
		const changed = await codeHash(device, app);
		expect(changed).not.toBe(first);

		await Bun.write(join(app, 'firmware', 'smartify_os_network.h'), `${header}// more\n`);
		expect(await codeHash(device, app)).not.toBe(changed);
	});

	test("follows the car's SmartifyOS, and leaves the owner's own lines alone", () => {
		const ini = [
			'[env:lights]',
			'platform = espressif32@6.0.0',
			'board = esp32dev',
			'lib_deps =',
			'\thttps://github.com/SmartifyOS/SmartifyOS-ESP32.git#v0.0.9',
			'\tmadhephaestus/ESP32Servo@^1.2.1',
			'platform_packages = something',
			'',
		].join('\n');
		expect(syncIni(ini, firmware)).toBe(
			[
				'[env:lights]',
				'platform = espressif32@7.1.3',
				'board = esp32dev',
				'lib_deps =',
				'\thttps://github.com/SmartifyOS/SmartifyOS-ESP32.git#v0.1.0',
				'\tmadhephaestus/ESP32Servo@^1.2.1',
				'platform_packages = something',
				'',
			].join('\n'),
		);
		expect(syncIni('lib_deps = https://x/SmartifyOS-ESP32#v0\nplatform = a\n', firmware)).toBe(
			`lib_deps = ${firmware.library}#v0.1.0\nplatform = espressif32@7.1.3\n`,
		);
		expect(() => syncIni('[env:x]\nboard = esp32dev\n', firmware)).toThrow('no longer names');
	});

	test('keeps its settings only when they are what they should be', () => {
		expect(parseSettings('{"device":"a","version":"1.2.3","code":null}')).toEqual({
			device: 'a',
			version: '1.2.3',
			code: null,
		});
		expect(parseSettings('{"device":"a","version":"1.2","code":null}')).toBeUndefined();
		expect(parseSettings('{"version":"1.2.3"}')).toBeUndefined();
		expect(parseSettings('not json')).toBeUndefined();
	});
});

describe('versions', () => {
	test('go up by one part, and the parts after it back to 0', () => {
		expect(raiseVersion('1.2.3', 'patch')).toBe('1.2.4');
		expect(raiseVersion('1.2.3', 'minor')).toBe('1.3.0');
		expect(raiseVersion('1.2.3', 'major')).toBe('2.0.0');
		expect(versionMacro('1.2.3')).toBe('1,2,3');
	});
});

describe('names', () => {
	test("a board is found by any name, and anything else is taken as PlatformIO's name", () => {
		expect(boardId('esp32')).toBe('esp32dev');
		expect(boardId('ESP32-S3')).toBe('esp32-s3-devkitc-1');
		expect(boardId('c3')).toBe('esp32-c3-devkitm-1');
		expect(boardId('lolin_s3')).toBe('lolin_s3');
	});

	test("a new device's name comes from what the driver reads", () => {
		expect(deviceName('Pop-up headlights')).toBe('popUpHeadlights');
		expect(deviceName('Seat heater')).toBe('seatHeater');
		expect(deviceName('2 buttons')).toBe('device2Buttons');
	});
});

describe("putting a device into the car's app", () => {
	const element = deviceCall({ node: 3, name: 'seatHeater', title: "Driver's seat" });

	test('writes it as Dart', () => {
		expect(element).toBe(`CanDevice(node: 3, name: 'seatHeater', title: "Driver's seat")`);
		expect(deviceCall({ node: 1, name: 'a', title: `It's "on"` })).toContain(
			`title: 'It\\'s "on"'`,
		);
	});

	test('goes at the end of the devices of the one CanConfig', () => {
		const source = `const carCan = CanConfig(
  devices: [
    MiataButtons.device,
    MiataHeadlights.device,
  ],
  // devices: [ in a comment does not count
  messages: [MiataButtons.pressed],
);
`;
		expect(addToConfig(source, element)).toBe(`const carCan = CanConfig(
  devices: [
    MiataButtons.device,
    MiataHeadlights.device,
    ${element},
  ],
  // devices: [ in a comment does not count
  messages: [MiataButtons.pressed],
);
`);
		expect(addToConfig('const c = CanConfig(messages: [a]);', element)).toBe(
			`const c = CanConfig(messages: [a], devices: [${element}]);`,
		);
		expect(addToConfig('const c = CanConfig(devices: list);', element)).toBeUndefined();
	});

	test('gets a CanConfig of its own in main.dart when the car has no CAN bus yet', () => {
		const source = `import 'package:smartify_os_core/smartify_os.dart';

Future<void> main() async {
  await SmartifyOs().init(
    extensions: [],
  );
}
`;
		const edited = addToInit(source, element) ?? '';
		expect(edited).toContain(`    can: CanConfig(devices: [${element}]),\n  );`);
		expect(edited).toContain("import 'package:smartify_os_core/can.dart';\n");
		expect(addToInit(edited, element)).toBeUndefined();
	});
});

describe('building', () => {
	test('reads which partitions a table has, to refuse one without room for updates', () => {
		const entry = (type: number, subtype: number) => [
			0xaa,
			0x50,
			type,
			subtype,
			...new Array(28).fill(0),
		];
		const table = new Uint8Array([
			...entry(1, 0x02),
			...entry(1, 0x00),
			...entry(0, 0x10),
			...entry(0, 0x11),
			0xff,
			0xff,
		]);
		expect(readPartitions(table)).toEqual([
			{ type: 1, subtype: 0x02 },
			{ type: 1, subtype: 0x00 },
			{ type: 0, subtype: 0x10 },
			{ type: 0, subtype: 0x11 },
		]);
	});

	test("shows the compiler's errors rather than the end of everything it printed", () => {
		const output = [
			'Compiling .pio/build/headlights/src/main.cpp.o',
			"src/main.cpp:12:3: error: 'moveLights' was not declared in this scope",
			'*** [.pio/build/headlights/src/main.cpp.o] Error 1',
			'========================= [FAILED] Took 2.31 seconds =========================',
		].join('\n');
		expect(compilerErrors(output)).toBe(
			"src/main.cpp:12:3: error: 'moveLights' was not declared in this scope",
		);
	});
});

describe('the firmware on a stick', () => {
	const built: BuiltFirmware = {
		bin: join(dir, 'firmware.bin'),
		size: 4,
		sha256: 'ab'.repeat(32),
		chip: 'esp32s3',
		version: '1.2.0',
	};

	test('is described in KEY=value lines SmartifyOS reads', () => {
		expect(renderDeviceConf('headlights', built).split('\n').slice(1)).toEqual([
			'FORMAT=1',
			'DEVICE=headlights',
			'FILE=headlights.bin',
			'VERSION=1.2.0',
			'SIZE=4',
			`SHA256=${'ab'.repeat(32)}`,
			'CHIP=esp32s3',
			'',
		]);
		expect(renderDeviceConf('front-lights', { ...built, chip: undefined })).not.toContain('CHIP');
		expect(renderDeviceConf('front-lights', built)).toContain('FILE=front_lights.bin\n');
	});

	test('goes into smartify-os/devices, next to whatever is there', async () => {
		await Bun.write(built.bin, 'BIN!');
		const stick = join(dir, 'stick');
		await Bun.write(join(stick, 'smartify-os', 'export.conf'), 'KIND=update\n');
		const written = await writeDeviceFirmware(stick, [{ device: 'headlights', built }]);
		expect(written.files).toEqual(['devices/headlights.bin', 'devices/headlights.conf']);
		expect(await Bun.file(join(stick, 'smartify-os', 'devices', 'headlights.bin')).text()).toBe(
			'BIN!',
		);
		expect(await Bun.file(join(stick, 'smartify-os', 'export.conf')).text()).toBe('KIND=update\n');
	});
});
