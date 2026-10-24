import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addToConfig } from './app.ts';
import type { BuiltFirmware } from './build.ts';
import type { FirmwareSource } from './network.ts';
import {
	arduinoBoard,
	boardId,
	createUsbDevice,
	isUsbDevice,
	listDevices,
	parseSettings,
	renderSketch,
	renderUsbIni,
	setSketchBaudRate,
} from './project.ts';
import {
	addSerialToInit,
	changeSerialDevice,
	definedSerialDevices,
	serialDeviceConstant,
} from './serial-app.ts';
import { writeDeviceFirmware } from './stick.ts';

const dir = await mkdtemp(join(tmpdir(), 'smartify-os-serial-'));

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const firmware: FirmwareSource = {
	library: 'https://github.com/SmartifyOS/SmartifyOS-ESP32.git',
	version: 'v0.1.0',
	platform: 'espressif32@7.1.3',
};

describe('a board on USB in the car app', () => {
	test('is a constant of its own, and its name goes into the SerialConfig', () => {
		expect(
			serialDeviceConstant({ name: 'dashboard', title: "Driver's Arduino", baudRate: 9600 }),
		).toBe(`/// Driver's Arduino, a board on a USB cable. Its sketch is in devices/dashboard/.
const dashboard = SerialDevice(name: 'dashboard', title: "Driver's Arduino", baudRate: 9600);`);

		expect(
			addToConfig('const c = SerialConfig(devices: [tacho]);', 'dashboard', 'SerialConfig'),
		).toBe('const c = SerialConfig(devices: [tacho, dashboard]);');
		expect(addToConfig('const c = SerialConfig();', 'dashboard', 'SerialConfig')).toBe(
			'const c = SerialConfig(devices: [dashboard]);',
		);
	});

	test('gets a SerialConfig of its own in main.dart when the car has none', () => {
		const source = `Future<void> main() async {
  await SmartifyOs().init(
    // serial: const SerialConfig(devices: [MiataTacho.device]),
    extensions: [],
  );
}
`;
		const edited = addSerialToInit(source, 'dashboard') ?? '';
		expect(edited).toContain('    serial: SerialConfig(devices: [dashboard]),\n  );');
		expect(addSerialToInit(edited, 'dashboard')).toBeUndefined();
	});

	test('is read back, and changed where it is written', async () => {
		const app = join(dir, 'read');
		await mkdir(join(app, 'lib'), { recursive: true });
		await Bun.write(
			join(app, 'lib', 'serial.dart'),
			`import 'package:smartify_os_core/serial.dart';

abstract final class MiataTacho {
  static const device = SerialDevice(
    name: 'tacho',
    title: 'Tachometer',
    baudRate: 9600,
  );
}

// SerialDevice(name: 'commented', title: 'Left out')
const dashboard = SerialDevice(name: 'dashboard', title: 'Dashboard');
`,
		);
		expect(await definedSerialDevices(app)).toEqual([
			{
				name: 'tacho',
				title: 'Tachometer',
				baudRate: 9600,
				port: null,
				file: 'lib/serial.dart',
				line: 4,
			},
			{
				name: 'dashboard',
				title: 'Dashboard',
				baudRate: 115200,
				port: null,
				file: 'lib/serial.dart',
				line: 12,
			},
		]);

		const changed = await changeSerialDevice(app, 'dashboard', {
			title: 'Dashboard Arduino',
			baudRate: 9600,
		});
		expect(changed).toMatchObject({ title: 'Dashboard Arduino', baudRate: 9600 });
		const tacho = await changeSerialDevice(app, 'tacho', { baudRate: 57600 });
		expect(tacho).toMatchObject({ title: 'Tachometer', baudRate: 57600 });
		expect(await changeSerialDevice(app, 'nobody', { baudRate: 9600 })).toBeUndefined();
	});
});

describe("a board on USB's project", () => {
	test('is a plain Arduino project for its board', () => {
		const device = { name: 'dash', title: 'Dash', board: 'uno', device: 'dash', baudRate: 9600 };
		const ini = renderUsbIni(device, firmware.platform);
		expect(ini).toContain('platform = atmelavr\n');
		expect(ini).toContain('board = uno\n');
		expect(ini).toContain('monitor_speed = 9600\n');
		expect(ini).not.toContain('SmartifyOS-ESP32');
		expect(renderUsbIni({ ...device, board: 'esp32dev' }, firmware.platform)).toContain(
			'platform = espressif32@7.1.3\n',
		);
		expect(boardId('nano')).toBe('nanoatmega328new');
		expect(arduinoBoard('esp32dev')).toBeUndefined();
	});

	test('has a sketch that says which device it is, the way the car asks', () => {
		const sketch = renderSketch({ device: 'dashboard', title: 'Dashboard', baudRate: 9600 });
		expect(sketch).toContain('"smartify-os:dashboard"');
		expect(sketch).toContain('line == "smartify-os?"');
		expect(sketch).toContain('Serial.begin(9600);');
		expect(sketch).toContain("Serial.readStringUntil('\\n');");
	});

	test('is written into devices/<name>, found again, and its speed changed', async () => {
		const app = join(dir, 'car');
		const made = await createUsbDevice(
			app,
			{ name: 'dash', title: 'Dash', board: 'uno', device: 'dash', baudRate: 9600 },
			firmware,
		);
		const [found] = await listDevices(app);
		expect(found?.settings).toEqual({
			device: 'dash',
			connection: 'usb',
			version: '1.0.0',
			code: null,
		});
		expect(found && isUsbDevice(found)).toBe(true);

		expect(await setSketchBaudRate(made.dir, 115200)).toBe(true);
		expect(await Bun.file(join(made.dir, 'src', 'main.cpp')).text()).toContain(
			'Serial.begin(115200);',
		);
		expect(await Bun.file(join(made.dir, 'platformio.ini')).text()).toContain(
			'monitor_speed = 115200\n',
		);
	});

	test('keeps a device on the CAN bus without a connection', () => {
		expect(parseSettings('{"device":"a","version":"1.0.0","code":null}')).toEqual({
			device: 'a',
			version: '1.0.0',
			code: null,
		});
		expect(
			parseSettings('{"device":"a","connection":"wifi","version":"1.0.0","code":null}'),
		).toBeUndefined();
	});
});

describe("a board on USB's firmware on a stick", () => {
	const built = (bin: string): BuiltFirmware => ({
		bin,
		size: 4,
		sha256: 'abcd',
		chip: 'esp32',
		version: '1.0.0',
	});

	test('has every image esptool writes, and how to write it', async () => {
		const build = join(dir, 'esp-build');
		await mkdir(build, { recursive: true });
		await Bun.write(join(build, 'bootloader.bin'), 'boot');
		await Bun.write(join(build, 'firmware.bin'), 'app!');
		const stick = join(dir, 'stick');
		const written = await writeDeviceFirmware(stick, [
			{
				device: 'dashboard',
				built: built(join(build, 'firmware.bin')),
				usb: {
					tool: 'esptool',
					chip: 'esp32',
					uploadBaud: 460800,
					images: [
						{ offset: 0x1000, path: join(build, 'bootloader.bin') },
						{ offset: 0x10000, path: join(build, 'firmware.bin') },
					],
				},
			},
		]);
		expect(written.files).toEqual([
			'devices/dashboard.bootloader.bin',
			'devices/dashboard.bin',
			'devices/dashboard.conf',
		]);
		const conf = await Bun.file(join(stick, 'smartify-os', 'devices', 'dashboard.conf')).text();
		expect(conf).toContain('CONNECTION=usb\n');
		expect(conf).toContain('TOOL=esptool\n');
		expect(conf).toContain('FILE=dashboard.bin\n');
		expect(conf).toMatch(
			/IMAGES=0x1000:dashboard\.bootloader\.bin:[0-9a-f]{64},0x10000:dashboard\.bin:[0-9a-f]{64}\n/,
		);
	});

	test('of an Arduino is its .hex, for avrdude', async () => {
		const build = join(dir, 'avr-build');
		await mkdir(build, { recursive: true });
		await Bun.write(join(build, 'firmware.hex'), ':00000001FF');
		const stick = join(dir, 'stick-avr');
		await writeDeviceFirmware(stick, [
			{
				device: 'tacho',
				built: built(join(build, 'firmware.hex')),
				usb: { tool: 'avrdude', mcu: 'atmega328p', uploadBaud: 57600 },
			},
		]);
		const conf = await Bun.file(join(stick, 'smartify-os', 'devices', 'tacho.conf')).text();
		expect(conf).toContain('TOOL=avrdude\nMCU=atmega328p\nUPLOAD_BAUD=57600\nFILE=tacho.hex\n');
		expect(conf).not.toContain('IMAGES=');
	});
});
