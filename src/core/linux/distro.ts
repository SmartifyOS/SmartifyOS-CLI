/**
 * The one Linux SmartifyOS supports on a car.
 *
 * Everything that names it reads it from here, the scripts that run on the car included
 * (they get it through export.conf), so moving to another release, or another apt based
 * distribution altogether, is an edit to this file and nothing else.
 *
 * Debian 13 on x64, and Raspberry Pi OS Lite on a Raspberry Pi, which is Debian 13 with
 * Raspberry Pi's kernel and reports itself as Debian 13 too. Why is in LINUX_SYSTEM.md in
 * the SmartifyOS repository.
 */
export const officialLinux = {
	/** `ID` in /etc/os-release. */
	id: 'debian',
	/** `VERSION_ID` in /etc/os-release. */
	versionId: '13',
	/** What a person reads. */
	name: 'Debian 13',
	/** What a Raspberry Pi runs of it. */
	piName: 'Raspberry Pi OS Lite (64-bit)',
	/** The container image of it, which builds for a car on any computer. */
	image: 'debian:13',
} as const;

/** The architectures a car can have, in SmartifyOS's own words (Flutter's, too). */
export type LinuxArch = 'x64' | 'arm64';

export const linuxArchs: readonly LinuxArch[] = ['x64', 'arm64'];

/** The architecture of this computer, when it is one a car can have. */
export function hostArch(): LinuxArch | undefined {
	if (process.arch === 'x64') return 'x64';
	if (process.arch === 'arm64') return 'arm64';
	return undefined;
}

/** Reads `ID` and `VERSION_ID` out of an os-release file. */
export function parseOsRelease(text: string): { id?: string; versionId?: string } {
	const values = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
		if (!match?.[1]) continue;
		values.set(match[1], (match[2] ?? '').replace(/^(["'])(.*)\1$/, '$2'));
	}
	return { id: values.get('ID'), versionId: values.get('VERSION_ID') };
}

/** Whether this computer runs the official Linux, which is what building for a car needs. */
export async function runsOfficialLinux(): Promise<boolean> {
	if (process.platform !== 'linux') return false;
	const file = Bun.file('/etc/os-release');
	if (!(await file.exists())) return false;
	const { id, versionId } = parseOsRelease(await file.text());
	return id === officialLinux.id && versionId === officialLinux.versionId;
}
