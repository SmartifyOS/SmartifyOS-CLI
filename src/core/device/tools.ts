import { join } from 'node:path';
import { type PathEnv, stateDir } from '../paths.ts';

/**
 * Where the tools the CLI installs for itself live, and what they need to find the rest of
 * themselves: PlatformIO, which builds the firmware of the devices on a car's CAN bus, and
 * uv, which is how PlatformIO gets a Python without the owner installing one.
 *
 * All of it is under the CLI's own folder, so deleting that folder is still a complete
 * uninstall, and none of it is ever looked for on PATH: a PlatformIO or a Python the owner
 * has for something else stays theirs, and every car's firmware is built the same way.
 */

/** The folder all of them are in. */
export function toolsDir(env?: PathEnv): string {
	return join(stateDir(env), 'tools');
}

/** Internal: a program's file name on this platform. */
function program(name: string): string {
	return process.platform === 'win32' ? `${name}.exe` : name;
}

/** uv itself, one standalone binary. */
export function uvPath(): string {
	return join(toolsDir(), 'uv', program('uv'));
}

/**
 * PlatformIO's own folder (`PLATFORMIO_CORE_DIR`), where it keeps the ESP32 platform and
 * toolchains it downloads on the first build.
 */
export function platformioDir(): string {
	return join(toolsDir(), 'platformio');
}

/** The Python environment PlatformIO is installed in, where its own installer puts it too. */
export function platformioPython(): string {
	return join(platformioDir(), 'penv');
}

/** The `pio` program. */
export function pioPath(): string {
	const venv = platformioPython();
	return process.platform === 'win32'
		? join(venv, 'Scripts', program('pio'))
		: join(venv, 'bin', 'pio');
}

/**
 * Internal: what keeps the owner's own Python setup out of PlatformIO's. Python ignores a
 * variable that is set but empty, which is the only way to take one away here.
 */
const noOuterPython = { PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '' };

/** What `pio` runs with. */
export function platformioEnv(): Record<string, string> {
	return {
		...noOuterPython,
		PLATFORMIO_CORE_DIR: platformioDir(),
		PLATFORMIO_SETTING_ENABLE_TELEMETRY: 'no',
		// It would otherwise suggest upgrading itself, which is the CLI's to decide.
		PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL: '3650',
		PLATFORMIO_DISABLE_PROGRESSBAR: 'true',
	};
}

/** What `uv` runs with. */
export function uvEnv(): Record<string, string> {
	const dir = toolsDir();
	return {
		...noOuterPython,
		// The owner's uv.toml is for their own projects, the same lesson as bunfig.toml.
		UV_NO_CONFIG: '1',
		UV_PYTHON_PREFERENCE: 'only-managed',
		UV_PYTHON_INSTALL_DIR: join(dir, 'python'),
		UV_PYTHON_BIN_DIR: join(dir, 'python', 'bin'),
		UV_CACHE_DIR: join(dir, 'uv-cache'),
		UV_NO_PROGRESS: '1',
	};
}
