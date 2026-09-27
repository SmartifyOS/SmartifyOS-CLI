import { join } from 'node:path';

/**
 * A car's app as pub leaves it: its own folder, and every package it resolved in a folder of
 * its own, found through `.dart_tool/package_config.json`.
 */
export async function fakeCar(dir: string): Promise<string> {
	const app = join(dir, 'car');
	const packages: Record<string, string> = {
		smartify_os_core: `name: smartify_os_core
version: 0.2.0
smartify_os:
  linux:
    build:
      apt: [libgstreamer1.0-dev]
    run:
      apt: [bluez, gstreamer1.0-plugins-good]
`,
		smartify_os_dashcam: `name: smartify_os_dashcam
dependencies:
  smartify_os_core: ">=0.2.0"
smartify_os:
  linux:
    build:
      apt: [libusb-1.0-0-dev]
    run:
      apt:
        - bluez
        - package: intel-media-va-driver
          arch: [x64]
        - Not A Package
      udev: [system/udev/70-dashcam.rules, system/udev/71-root.rules]
      groups: [plugdev, sudo]
      systemd: [dashcam.service]
`,
		plain: 'name: plain\n',
	};
	for (const [name, text] of Object.entries(packages)) {
		await Bun.write(join(dir, name, 'pubspec.yaml'), text);
	}
	await Bun.write(join(dir, 'smartify_os_dashcam', 'README.md'), '# Dashcam\n');
	await Bun.write(
		join(dir, 'smartify_os_dashcam', 'system', 'udev', '70-dashcam.rules'),
		'SUBSYSTEM=="usb", MODE="0660", GROUP="plugdev"\n',
	);
	await Bun.write(
		join(dir, 'smartify_os_dashcam', 'system', 'udev', '71-root.rules'),
		'SUBSYSTEM=="usb", RUN+="/bin/sh"\n',
	);
	await Bun.write(
		join(app, 'pubspec.yaml'),
		`name: car
version: 1.0.0
dependencies:
  smartify_os_core: any
  smartify_os_dashcam: any
dependency_overrides:
  smartify_os_core:
    git:
      url: https://example.com/smartify_os.git
      path: smartify_os_core
      ref: v0.2.0
smartify_os:
  linux:
    run:
      apt: [can-utils]
`,
	);
	await Bun.write(join(app, 'lib', 'main.dart'), 'void main() {}\n');
	// A folder of code that happens to be called build, which is not build output.
	await Bun.write(join(app, 'lib', 'build', 'keep.dart'), '// kept\n');
	await Bun.write(join(app, 'build', 'linux', 'junk'), 'build output\n');
	await Bun.write(
		join(app, 'linux', 'CMakeLists.txt'),
		'cmake_minimum_required(VERSION 3.13)\nset(BINARY_NAME "car_app")\n',
	);
	await Bun.write(
		join(app, '.dart_tool', 'package_config.json'),
		JSON.stringify({
			configVersion: 2,
			packages: [
				{ name: 'car', rootUri: '../' },
				...Object.keys(packages).map((name) => ({ name, rootUri: `../../${name}/` })),
			],
		}),
	);
	return app;
}
