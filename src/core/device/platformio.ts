import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { lastLines, run, runOrThrow } from '../process.ts';
import { unpack } from '../self-update/install.ts';
import { sha256OfFile } from '../self-update/release.ts';
import { currentTarget, isMusl, type ReleaseTarget } from '../self-update/target.ts';
import { pioPath, platformioDir, platformioPython, toolsDir, uvPath } from './tools.ts';

/**
 * Setting up PlatformIO, which builds the firmware of the devices on a car's CAN bus, so the
 * owner never installs Python or `pio`.
 *
 * PlatformIO is a Python program, so it is installed with uv, a single binary that brings a
 * Python of its own. uv is pinned and checked against checksums kept right here rather than
 * ones downloaded next to it, and PlatformIO is pinned too, so every car's firmware is built
 * by exactly the tools it was tried with. Moving either on is a change to this file.
 */

/** The uv release used, and the checksum of its archive for each build of the CLI. */
export const uvVersion = '0.12.20';

const uvArchives: Partial<Record<ReleaseTarget, { name: string; sha256: string }>> = {
	'darwin-arm64': {
		name: 'uv-aarch64-apple-darwin.tar.gz',
		sha256: '848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca',
	},
	'darwin-x64': {
		name: 'uv-x86_64-apple-darwin.tar.gz',
		sha256: 'ac54283d211fd77cdc152b67606dbaf6406ff4ab03f3af4ae99468fa8e887141',
	},
	'linux-x64': {
		name: 'uv-x86_64-unknown-linux-gnu.tar.gz',
		sha256: '6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f',
	},
	'linux-arm64': {
		name: 'uv-aarch64-unknown-linux-gnu.tar.gz',
		sha256: '8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e',
	},
	'windows-x64': {
		name: 'uv-x86_64-pc-windows-msvc.zip',
		sha256: '95f9bc30fbb3574d276e28ac4a6de932d25153645853d13da8c21eec3bc88d06',
	},
	'windows-arm64': {
		name: 'uv-aarch64-pc-windows-msvc.zip',
		sha256: 'b6bd9218855591742ffd3b00fcf2044b4d2fb6446b6a3545e0dfee447e950388',
	},
};

/** The PlatformIO installed, and the Python it runs on. */
export const platformioVersion = '6.1.19';
export const pythonVersion = '3.12';

/** Internal: written into the environment once PlatformIO is installed in it, and only then. */
function markerPath(): string {
	return join(platformioPython(), 'smartify-os-installed');
}

/** Internal: what the marker says, so moving either version on installs it again. */
function markerText(): string {
	return `platformio ${platformioVersion}, python ${pythonVersion}\n`;
}

/** Whether PlatformIO is installed, at the version this CLI wants. */
export async function isPlatformioReady(): Promise<boolean> {
	const marker = Bun.file(markerPath());
	return existsSync(pioPath()) && (await marker.exists()) && (await marker.text()) === markerText();
}

/** Whether PlatformIO has built anything yet, which downloads the ESP32 tools the first time. */
export function hasBuiltBefore(): boolean {
	return existsSync(join(platformioDir(), 'platforms'));
}

export type SetUpStep = 'uv' | 'platformio';

/**
 * Installs PlatformIO, and the uv it is installed with, when they are not there yet.
 *
 * @throws {CliError} on a computer PlatformIO's ESP32 tools do not run on, or when a
 * download or the install fails.
 */
export async function setUpPlatformio(onStep?: (step: SetUpStep) => void): Promise<void> {
	if (await isPlatformioReady()) return;
	const archive = uvArchiveFor();

	onStep?.('uv');
	await installUv(archive);

	onStep?.('platformio');
	const venv = platformioPython();
	// Made again from nothing, since an environment cannot be moved into place once whole.
	await rm(venv, { recursive: true, force: true });
	await runOrThrow('uv', ['venv', '--seed', '--python', pythonVersion, venv], {
		message: 'Could not get a Python for PlatformIO.',
		hint: 'Check your internet connection.',
	});
	await runOrThrow('uv', ['pip', 'install', '--python', venv, `platformio==${platformioVersion}`], {
		message: 'Could not install PlatformIO.',
		hint: 'Check your internet connection.',
	});
	if (!existsSync(pioPath())) {
		throw new CliError('PlatformIO was installed, but its pio program is missing.', {
			hint: 'Please report it at https://github.com/Mauznemo/SmartifyOS-CLI/issues',
		});
	}
	await Bun.write(markerPath(), markerText());
}

/** Internal: the uv archive for this computer. */
function uvArchiveFor(): { name: string; sha256: string } {
	if (isMusl({ platform: process.platform, arch: process.arch, exists: existsSync })) {
		throw new CliError(
			"The ESP32 tools PlatformIO builds firmware with do not run on Alpine's musl.",
			{
				hint: 'Build the firmware on another computer: macOS, Windows, or a Linux like Debian or Ubuntu.',
			},
		);
	}
	const archive = uvArchives[currentTarget()];
	if (!archive) {
		throw new CliError('Building firmware does not work on this computer.', {
			hint: 'It works on macOS, Windows and Linux, on 64 bit Intel and ARM.',
		});
	}
	return archive;
}

/** Internal: puts uv in place, unless the right one is there already. */
async function installUv(archive: { name: string; sha256: string }): Promise<void> {
	const path = uvPath();
	if (existsSync(path)) {
		const found = await run('uv', ['--version']);
		if (found.code === 0 && found.stdout.split(' ')[1]?.trim() === uvVersion) return;
	}

	await mkdir(toolsDir(), { recursive: true });
	const staging = await mkdtemp(join(toolsDir(), '.uv-'));
	try {
		const download = join(staging, archive.name);
		const url = `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${archive.name}`;
		const response = await fetch(url).catch(() => undefined);
		if (!response?.ok) {
			throw new CliError(`Could not download uv, which PlatformIO is installed with.`, {
				hint: `Check your internet connection. ${url}${response ? ` answered ${response.status}.` : ''}`,
			});
		}
		await Bun.write(download, response);
		if ((await sha256OfFile(download)) !== archive.sha256) {
			throw new CliError('The download of uv does not match its checksum.', {
				hint: 'Something went wrong on the way. Please try again.',
			});
		}

		await unpack(download, staging);
		const unpacked = await findFile(staging, process.platform === 'win32' ? 'uv.exe' : 'uv');
		if (!unpacked) throw new CliError('The download of uv did not contain uv.');
		if (process.platform !== 'win32') await chmod(unpacked, 0o755);
		await mkdir(join(path, '..'), { recursive: true });
		await rm(path, { force: true });
		await rename(unpacked, path);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/** Internal: a file by name, in a folder or one level below it, where an archive puts it. */
async function findFile(dir: string, name: string): Promise<string | undefined> {
	if (existsSync(join(dir, name))) return join(dir, name);
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && existsSync(join(dir, entry.name, name))) {
			return join(dir, entry.name, name);
		}
	}
	return undefined;
}

/** A serial port, as `pio device list` reports it. */
export interface SerialPort {
	port: string;
	description: string;
	hwid: string;
}

/**
 * The USB to serial chips ESP32 boards are programmed through, by USB vendor: Espressif's
 * own USB on the S3 and C3, Silicon Labs' CP210x, WCH's CH340 and CH9102, FTDI. A CANable is
 * none of these, so it is never taken for a board.
 */
const boardVendors = ['303A', '10C4', '1A86', '0403'];

/**
 * The serial ports on USB (not the Bluetooth or debug ones a Mac always has), and which of
 * them look like an ESP32 board.
 */
export async function listPorts(): Promise<{ usb: SerialPort[]; boards: SerialPort[] }> {
	const result = await runOrThrow('pio', ['device', 'list', '--serial', '--json-output'], {
		message: 'Could not list the USB ports.',
	});
	let all: SerialPort[] = [];
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (Array.isArray(parsed)) {
			all = parsed
				.filter((entry): entry is SerialPort => typeof entry?.port === 'string')
				.map((entry) => ({
					port: entry.port,
					description: String(entry.description ?? ''),
					hwid: String(entry.hwid ?? ''),
				}));
		}
	} catch {
		// No ports it could describe, which is the same as none.
	}
	const vendor = (port: SerialPort) =>
		/VID:PID=([0-9A-Fa-f]{4}):/.exec(port.hwid)?.[1]?.toUpperCase();
	const usb = all.filter((port) => vendor(port) !== undefined);
	const boards = usb.filter((port) => boardVendors.includes(vendor(port) ?? ''));
	return { usb, boards };
}

/** What a failed PlatformIO run printed, for an error's hint. */
export function pioOutput(result: { stdout: string; stderr: string }): string {
	return lastLines(`${result.stdout}\n${result.stderr}`, 20);
}
