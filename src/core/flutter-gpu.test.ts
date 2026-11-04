import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	androidWithFlutterGpu,
	linuxWithFlutterGpu,
	macosWithFlutterGpu,
	switchOnFlutterGpu,
	windowsWithFlutterGpu,
} from './flutter-gpu.ts';

// What `flutter create` writes, cut down to the lines around the place.
const linux = `static void my_application_activate(GApplication* application) {
  gtk_window_set_default_size(window, 1280, 720);

  g_autoptr(FlDartProject) project = fl_dart_project_new();
  fl_dart_project_set_dart_entrypoint_arguments(
      project, self->dart_entrypoint_arguments);
}
`;

const android = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="my_car"
        android:icon="@mipmap/ic_launcher">
        <activity android:name=".MainActivity">
        </activity>
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
`;

const macos = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
</dict>
</plist>
`;

const windows = `int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();
}
`;

describe('switching Flutter GPU on', () => {
	test('Linux, right after the project is made', () => {
		const result = linuxWithFlutterGpu(linux) ?? '';
		expect(result).toContain(
			'  g_autoptr(FlDartProject) project = fl_dart_project_new();\n  // SmartifyOS draws',
		);
		expect(result).toContain('  fl_dart_project_set_enable_flutter_gpu(project, TRUE);\n');
		expect(result.indexOf('enable_flutter_gpu')).toBeLessThan(
			result.indexOf('set_dart_entrypoint_arguments'),
		);
	});

	test('Android, inside <application>', () => {
		const result = androidWithFlutterGpu(android) ?? '';
		expect(result).toContain(
			'        <meta-data\n            android:name="io.flutter.embedding.android.EnableFlutterGPU"\n            android:value="true" />\n    </application>',
		);
	});

	test('macOS, in the top <dict>', () => {
		const result = macosWithFlutterGpu(macos) ?? '';
		expect(result).toContain(
			'\t<string>NSApplication</string>\n\t<key>FLTEnableFlutterGPU</key>\n\t<true/>\n</dict>',
		);
	});

	test('Windows, right after the project is made', () => {
		const result = windowsWithFlutterGpu(windows) ?? '';
		expect(result).toContain('  project.set_enable_flutter_gpu(true);\n\n  std::vector');
	});

	test('only once', () => {
		for (const [edit, text] of [
			[linuxWithFlutterGpu, linux],
			[androidWithFlutterGpu, android],
			[macosWithFlutterGpu, macos],
			[windowsWithFlutterGpu, windows],
		] as const) {
			const once = edit(text) ?? '';
			expect(once).not.toBe(text);
			expect(edit(once)).toBe(once);
		}
	});

	test('a file without the place gives nothing, for the owner to do by hand', () => {
		expect(linuxWithFlutterGpu('int main() {}\n')).toBeUndefined();
		expect(androidWithFlutterGpu('<manifest />\n')).toBeUndefined();
		expect(macosWithFlutterGpu('<plist />\n')).toBeUndefined();
		expect(windowsWithFlutterGpu('int main() {}\n')).toBeUndefined();
	});

	test('in an app, every platform it has and only those', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'smartify-os-gpu-'));
		try {
			await Bun.write(join(dir, 'linux/runner/my_application.cc'), linux);
			await Bun.write(join(dir, 'macos/Runner/Info.plist'), '<plist />\n');
			const first = await switchOnFlutterGpu(dir);
			expect(first.changed).toEqual(['linux/runner/my_application.cc']);
			expect(first.manual).toHaveLength(1);
			expect(first.manual[0]).toStartWith('macos/Runner/Info.plist: ');
			expect((await switchOnFlutterGpu(dir)).changed).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
