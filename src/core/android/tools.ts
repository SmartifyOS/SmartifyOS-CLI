import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../../utils/errors.ts';
import { toolsDir } from '../device/tools.ts';
import { probe, run } from '../process.ts';
import { unpack } from '../self-update/install.ts';
import { sha256OfFile } from '../self-update/release.ts';

/**
 * What building a car's app for Android needs on this computer besides Flutter, finding it,
 * and installing what is missing:
 *
 * - the Android SDK, with its command line tools (sdkmanager, which installs the rest) and
 *   platform tools (adb, which talks to the tablet),
 * - Google's licence for it accepted, without which Gradle downloads nothing it needs,
 * - a Java of at least {@link minimumJava}, which Gradle runs on.
 *
 * Whatever Flutter builds with already is used: Android Studio's SDK and its own Java, or ones
 * the owner pointed Flutter at. Only what is missing is installed, into
 * `~/.smartify-os/tools/android-sdk` and `~/.smartify-os/tools/jdk`, and Flutter is told
 * where they are with `flutter config`. The rest (the Android platform, build tools, the NDK)
 * Gradle downloads by itself on the first build, and the CMake versions packages pin are
 * installed before every build (src/core/android/sdk.ts).
 */

/** The oldest Java the Android Gradle plugin Flutter uses runs on. */
export const minimumJava = 17;

/** The Java installed when there is none: a long term release of Eclipse Temurin. */
const installedJava = 21;

/** Where the SDK goes when this computer has none. */
export function ownAndroidSdk(): string {
	return join(toolsDir(), 'android-sdk');
}

/** Where Java goes when this computer has none. */
export function ownJdk(): string {
	return join(toolsDir(), 'jdk');
}

/** Where an Android SDK can be: where the owner said, then where Android Studio puts it. */
export function androidSdkRoots(
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): string[] {
	const fallback =
		platform === 'darwin'
			? join(home, 'Library', 'Android', 'sdk')
			: platform === 'win32'
				? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk')
				: join(home, 'Android', 'Sdk');
	const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, fallback];
	return roots.filter((root): root is string => typeof root === 'string' && root !== '');
}

/** What `flutter config --machine` says Flutter builds for Android with. */
export interface FlutterAndroidConfig {
	sdk?: string;
	jdk?: string;
	studio?: string;
}

/** Where Flutter builds for Android with, the folders that are there. */
export async function flutterAndroidConfig(): Promise<FlutterAndroidConfig> {
	const result = await run('flutter', ['config', '--machine'], { timeoutMs: 60_000 }).catch(
		() => undefined,
	);
	if (!result) return {};
	try {
		const config = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as Record<
			string,
			unknown
		>;
		const dir = (key: string) => {
			const value = config[key];
			return typeof value === 'string' && existsSync(value) ? value : undefined;
		};
		return { sdk: dir('android-sdk'), jdk: dir('jdk-dir'), studio: dir('android-studio-dir') };
	} catch {
		return {};
	}
}

/** A Java this computer has. */
export interface FoundJava {
	/** Its home, what `JAVA_HOME` is set to. */
	home: string;
	/** Its major version, `21`. */
	version: number;
}

/** What this computer has for building for Android, and what is missing. */
export interface AndroidTools {
	sdk: string | undefined;
	/** The sdkmanager program, from the SDK's command line tools. */
	sdkmanager: string | undefined;
	/** The adb program, from the SDK's platform tools. */
	adb: string | undefined;
	/** Whether Google's licence for the SDK is accepted, so Gradle may download into it. */
	licences: boolean;
	/** The Java Gradle runs on, the newest one found when none is new enough. */
	java: FoundJava | undefined;
	/** Where Flutter was told the SDK and Java are, so a missing one is set with `flutter config`. */
	flutter: FlutterAndroidConfig;
}

/** What is missing, in words: `the Android SDK`, `Java 17 or newer`. Empty when nothing is. */
export function missingAndroidTools(tools: AndroidTools): string[] {
	const missing: string[] = [];
	if (!tools.sdk) missing.push('the Android SDK');
	else {
		if (!tools.sdkmanager) missing.push("the SDK's command line tools");
		if (!tools.adb) missing.push("the SDK's platform tools");
		if (!tools.licences) missing.push("the SDK's licence, accepted");
	}
	if (!tools.java || tools.java.version < minimumJava) missing.push(`Java ${minimumJava} or newer`);
	return missing;
}

/** Internal: a program's file name on this platform, `.bat` for sdkmanager on Windows. */
function exe(name: string, script = false): string {
	if (process.platform !== 'win32') return name;
	return script ? `${name}.bat` : `${name}.exe`;
}

/** sdkmanager in an SDK, from `cmdline-tools/latest` or any other version of them. */
export function sdkmanagerIn(sdk: string): string | undefined {
	const name = exe('sdkmanager', true);
	const candidates = [join(sdk, 'cmdline-tools', 'latest', 'bin', name)];
	try {
		const versions = readdirSync(join(sdk, 'cmdline-tools'));
		for (const version of versions.sort().reverse()) {
			candidates.push(join(sdk, 'cmdline-tools', version, 'bin', name));
		}
	} catch {
		// No command line tools at all.
	}
	candidates.push(join(sdk, 'tools', 'bin', name));
	return candidates.find((path) => existsSync(path));
}

/** Internal: the major version a `java -version` says, `21` of `openjdk version "21.0.8"`. */
export function javaMajor(text: string): number | undefined {
	const version = /version "([^"]+)"/.exec(text)?.[1];
	if (!version) return undefined;
	const [first, second] = version.split('.');
	// Java 8 and older call themselves 1.8.
	const major = first === '1' ? Number(second) : Number(first);
	return Number.isFinite(major) ? major : undefined;
}

/** Internal: the version of the Java at a home, undefined when it does not run. */
async function javaAt(home: string): Promise<FoundJava | undefined> {
	const result = await probe(join(home, 'bin', exe('java')), ['-version']);
	const version = result?.code === 0 ? javaMajor(`${result.stderr}\n${result.stdout}`) : undefined;
	return version === undefined ? undefined : { home, version };
}

/** Internal: where Android Studio keeps its own Java. */
function studioJava(studio: string): string[] {
	return [join(studio, 'jbr', 'Contents', 'Home'), join(studio, 'jbr'), join(studio, 'jre')];
}

/** Internal: the Java Flutter builds with, or the best one this computer has. */
async function findJava(flutter: FlutterAndroidConfig): Promise<FoundJava | undefined> {
	const homes = [
		flutter.jdk,
		...(flutter.studio ? studioJava(flutter.studio) : []),
		process.env.JAVA_HOME,
		ownJdk(),
	].filter((home): home is string => typeof home === 'string' && home !== '' && existsSync(home));
	let best: FoundJava | undefined;
	for (const home of homes) {
		const found = await javaAt(home);
		if (found && found.version >= minimumJava) return found;
		if (found && (!best || found.version > best.version)) best = found;
	}
	return best;
}

/** Looks at everything building for Android needs. Never throws. */
export async function findAndroidTools(): Promise<AndroidTools> {
	const flutter = await flutterAndroidConfig();
	const sdk = [flutter.sdk, ...androidSdkRoots(), ownAndroidSdk()].find(
		(root): root is string => root !== undefined && existsSync(root),
	);
	const adb = sdk ? join(sdk, 'platform-tools', exe('adb')) : undefined;
	return {
		sdk,
		sdkmanager: sdk ? sdkmanagerIn(sdk) : undefined,
		adb: adb && existsSync(adb) ? adb : undefined,
		licences: sdk ? existsSync(join(sdk, 'licenses', 'android-sdk-license')) : false,
		java: await findJava(flutter),
		flutter,
	};
}

/** What sdkmanager runs with: the Java found, and the SDK it works on. */
export function sdkmanagerEnv(tools: AndroidTools): Record<string, string | undefined> {
	return {
		...process.env,
		...(tools.java ? { JAVA_HOME: tools.java.home } : {}),
		...(tools.sdk ? { ANDROID_HOME: tools.sdk, ANDROID_SDK_ROOT: tools.sdk } : {}),
	};
}

/**
 * Runs sdkmanager, answering yes to every licence it shows: installing anything from the SDK
 * asks to accept Google's licence for it, and `setup --android` asked the owner already.
 */
export async function runSdkmanager(
	tools: AndroidTools,
	args: string[],
): Promise<{ code: number; output: string }> {
	if (!tools.sdkmanager) throw new CliError("The Android SDK's command line tools are missing.");
	const proc = Bun.spawn([tools.sdkmanager, ...args], {
		stdin: new TextEncoder().encode('y\n'.repeat(50)),
		stdout: 'pipe',
		stderr: 'pipe',
		env: sdkmanagerEnv(tools),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: `${stdout}\n${stderr}`.trim() };
}

export type AndroidSetUpStep = 'java' | 'cmdline-tools' | 'platform-tools' | 'licences' | 'flutter';

/** What {@link setUpAndroid} installed, by name, and what the computer has now. */
export interface AndroidSetUp {
	installed: string[];
	tools: AndroidTools;
}

/**
 * Installs whatever building for Android is missing, and tells Flutter where it is.
 *
 * @throws {CliError} saying what could not be installed.
 */
export async function setUpAndroid(
	onStep?: (step: AndroidSetUpStep) => void,
): Promise<AndroidSetUp> {
	let tools = await findAndroidTools();
	const installed: string[] = [];

	if (!tools.java || tools.java.version < minimumJava) {
		onStep?.('java');
		await installJava();
		installed.push(`Java ${installedJava}`);
		tools = { ...tools, java: await javaAt(await javaHomeIn(ownJdk())) };
	}

	const sdk = tools.sdk ?? ownAndroidSdk();
	if (!tools.sdkmanager) {
		onStep?.('cmdline-tools');
		await installCommandLineTools(sdk);
		installed.push("the Android SDK's command line tools");
		tools = { ...tools, sdk, sdkmanager: sdkmanagerIn(sdk) };
	}

	// Installing a package accepts Google's licence for it, which is the only way the newest
	// command line tools take (they say --licenses is no longer needed). Older ones need it.
	if (!tools.adb) {
		onStep?.('platform-tools');
		const result = await runSdkmanager(tools, ['platform-tools']);
		if (result.code !== 0 || !existsSync(join(sdk, 'platform-tools', exe('adb')))) {
			throw new CliError("The Android SDK's platform tools could not be installed.", {
				hint: lastLines(result.output),
			});
		}
		installed.push("the SDK's platform tools");
	}
	const licence = join(sdk, 'licenses', 'android-sdk-license');
	if (!existsSync(licence)) {
		onStep?.('licences');
		const accepted = await runSdkmanager(tools, ['--licenses']);
		if (!existsSync(licence)) {
			throw new CliError("Google's licence for the Android SDK could not be accepted.", {
				hint: `Open Android Studio once and accept it there.\n${lastLines(accepted.output)}`,
			});
		}
		installed.push("the SDK's licence");
	}

	// Flutter finds Android Studio's SDK and Java by itself, but not the CLI's own.
	const tell: string[] = [];
	if (sdk === ownAndroidSdk() && tools.flutter.sdk !== sdk) tell.push(`--android-sdk=${sdk}`);
	const java = tools.java;
	if (java?.home.startsWith(ownJdk()) && tools.flutter.jdk !== java.home) {
		tell.push(`--jdk-dir=${java.home}`);
	}
	if (tell.length > 0) {
		onStep?.('flutter');
		const result = await run('flutter', ['config', ...tell]);
		if (result.code !== 0) {
			throw new CliError('Flutter could not be told where the Android SDK and Java are.', {
				hint: lastLines(`${result.stdout}\n${result.stderr}`),
			});
		}
	}

	return { installed, tools: await findAndroidTools() };
}

function lastLines(text: string, count = 8): string {
	return text.trim().split('\n').slice(-count).join('\n');
}

/** Internal: downloads a file, failing with what to do when it does not come. */
async function download(url: string, to: string, what: string): Promise<void> {
	const response = await fetch(url).catch(() => undefined);
	if (!response?.ok) {
		throw new CliError(`Could not download ${what}.`, {
			hint: `Check your internet connection. ${url}${response ? ` answered ${response.status}.` : ''}`,
		});
	}
	if (!response.body) throw new CliError(`Could not download ${what}.`);
	// Streamed with a reader: Bun.write of a big response spins and never finishes.
	const writer = Bun.file(to).writer();
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			writer.write(value);
		}
	} catch (error) {
		throw new CliError(`The download of ${what} broke off.`, {
			hint: `Check your internet connection and try again. ${error instanceof Error ? error.message : ''}`.trim(),
		});
	} finally {
		await writer.end();
	}
}

/** Internal: the hash of a file, any kind Bun knows. */
async function hashOf(path: string, kind: 'sha1' | 'sha256'): Promise<string> {
	if (kind === 'sha256') return await sha256OfFile(path);
	const hasher = new Bun.CryptoHasher('sha1');
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest('hex');
}

/** The SDK's command line tools for this computer, out of Google's list of SDK packages. */
export function commandLineToolsArchive(
	repository: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): { url: string; sha1: string } | undefined {
	const block = /<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/.exec(
		repository,
	)?.[1];
	if (!block) return undefined;
	const os = platform === 'darwin' ? 'macosx' : platform === 'win32' ? 'windows' : 'linux';
	const hostArch = arch === 'arm64' ? 'aarch64' : 'x64';
	for (const archive of block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
		const text = archive[1] ?? '';
		if (/<host-os>([^<]+)<\/host-os>/.exec(text)?.[1] !== os) continue;
		const archOf = /<host-arch>([^<]+)<\/host-arch>/.exec(text)?.[1];
		if (archOf && archOf !== hostArch) continue;
		const url = /<url>([^<]+)<\/url>/.exec(text)?.[1];
		const sha1 = /<checksum type="sha1">([0-9a-f]+)<\/checksum>/.exec(text)?.[1];
		if (url && sha1) return { url: `https://dl.google.com/android/repository/${url}`, sha1 };
	}
	return undefined;
}

/** Internal: downloads the command line tools into `<sdk>/cmdline-tools/latest`. */
async function installCommandLineTools(sdk: string): Promise<void> {
	const list = 'https://dl.google.com/android/repository/repository2-3.xml';
	const response = await fetch(list).catch(() => undefined);
	const archive = response?.ok ? commandLineToolsArchive(await response.text()) : undefined;
	if (!archive) {
		throw new CliError("Could not find the Android SDK's command line tools for this computer.", {
			hint: `Check your internet connection. ${list}${response && !response.ok ? ` answered ${response.status}.` : ''}`,
		});
	}

	await mkdir(sdk, { recursive: true });
	const staging = await mkdtemp(join(sdk, '.cmdline-tools-'));
	try {
		const zip = join(staging, 'cmdline-tools.zip');
		await download(archive.url, zip, "the Android SDK's command line tools");
		if ((await hashOf(zip, 'sha1')) !== archive.sha1) {
			throw new CliError(
				"The download of the Android SDK's command line tools does not match its checksum.",
				{
					hint: 'Something went wrong on the way. Please try again.',
				},
			);
		}
		await unpack(zip, staging);
		// The zip holds one `cmdline-tools` folder, which sdkmanager wants as cmdline-tools/latest.
		const target = join(sdk, 'cmdline-tools', 'latest');
		await mkdir(join(sdk, 'cmdline-tools'), { recursive: true });
		await rm(target, { recursive: true, force: true });
		await rename(join(staging, 'cmdline-tools'), target);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/** Internal: the home of a JDK unpacked into a folder, `Contents/Home` of a macOS one. */
async function javaHomeIn(folder: string): Promise<string> {
	const java = exe('java');
	for (const home of [folder, join(folder, 'Contents', 'Home')]) {
		if (existsSync(join(home, 'bin', java))) return home;
	}
	throw new CliError(`There is no Java in ${folder}.`);
}

/** Internal: downloads Temurin into {@link ownJdk}, checked against Adoptium's checksum. */
async function installJava(): Promise<void> {
	const os =
		process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
	const api = `https://api.adoptium.net/v3/assets/latest/${installedJava}/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`;
	const response = await fetch(api).catch(() => undefined);
	const assets = response?.ok ? ((await response.json().catch(() => [])) as unknown[]) : [];
	const binary = (
		assets[0] as { binary?: { package?: { link?: string; checksum?: string; name?: string } } }
	)?.binary?.package;
	if (!binary?.link || !binary.checksum || !binary.name) {
		throw new CliError(`Could not find Java ${installedJava} for this computer.`, {
			hint: `Check your internet connection. ${api}`,
		});
	}

	await mkdir(toolsDir(), { recursive: true });
	const staging = await mkdtemp(join(toolsDir(), '.jdk-'));
	try {
		const archive = join(staging, binary.name);
		await download(binary.link, archive, `Java ${installedJava}`);
		if ((await hashOf(archive, 'sha256')) !== binary.checksum) {
			throw new CliError(`The download of Java ${installedJava} does not match its checksum.`, {
				hint: 'Something went wrong on the way. Please try again.',
			});
		}
		const unpacked = join(staging, 'unpacked');
		await mkdir(unpacked);
		await unpack(archive, unpacked);
		// It unpacks into one folder named after the release, `jdk-21.0.13+9`.
		const [folder] = (await readdir(unpacked, { withFileTypes: true })).filter((e) =>
			e.isDirectory(),
		);
		if (!folder) throw new CliError(`The download of Java ${installedJava} is empty.`);
		await rm(ownJdk(), { recursive: true, force: true });
		await rename(join(unpacked, folder.name), ownJdk());
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}
