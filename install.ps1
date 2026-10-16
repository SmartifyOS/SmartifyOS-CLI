<#
.SYNOPSIS
	Installs the SmartifyOS CLI on Windows.

.DESCRIPTION
	Run this in PowerShell:

		irm https://smartify-os.com/install.ps1 | iex

	It downloads one file, checks it against the published checksum, puts it in your user
	folder and adds it to your PATH. It does not need administrator rights and it does not
	touch anything outside your user folder.

	Options, all optional, set them before running:
		$env:SMARTIFY_OS_VERSION = 'v0.2.0'      install a specific release
		$env:SMARTIFY_OS_INSTALL_DIR = 'C:\...'  install somewhere else
		$env:SMARTIFY_OS_NO_MODIFY_PATH = '1'    do not touch your PATH
		$env:SMARTIFY_OS_BASE_URL = '...'        download from a mirror instead of GitHub

.NOTES
	Everything lives inside one function that is called at the bottom. That is on purpose,
	because `irm | iex` runs this in the user's own session, where a bare `exit` would
	close their terminal. Failures throw instead, and the wrapper at the bottom catches.
#>

Set-StrictMode -Version Latest

function Invoke-SmartifyOsInstall {
	[CmdletBinding()]
	param()

	$ErrorActionPreference = 'Stop'

	$repo = 'SmartifyOS/SmartifyOS-CLI'
	$binName = 'smartify-os'
	$failSentinel = 'SmartifyOsInstallFailed'

	function Get-EnvOrDefault([string]$Name, [string]$Default) {
		$value = [Environment]::GetEnvironmentVariable($Name)
		if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
		return $value
	}

	function Write-Step([string]$Message) { Write-Host "  * $Message" -ForegroundColor Cyan }
	function Write-Ok([string]$Message) { Write-Host "  + $Message" -ForegroundColor Green }

	function Write-Fail([string]$Message, [string]$Hint) {
		Write-Host ''
		Write-Host "  ! $Message" -ForegroundColor Red
		if ($Hint) { Write-Host "    $Hint" -ForegroundColor DarkGray }
		Write-Host ''
		throw $failSentinel
	}

	$version = Get-EnvOrDefault 'SMARTIFY_OS_VERSION' 'latest'
	$installDir = Get-EnvOrDefault 'SMARTIFY_OS_INSTALL_DIR' (Join-Path $env:LOCALAPPDATA 'SmartifyOS\bin')

	Write-Host ''
	Write-Host '  SmartifyOS ' -ForegroundColor Cyan -NoNewline
	Write-Host 'installer' -ForegroundColor DarkGray
	Write-Host ''

	# --- Work out which build this machine needs -----------------------------

	$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
	$target = switch ($architecture) {
		'X64' { 'windows-x64' }
		'Arm64' { 'windows-arm64' }
		default { Write-Fail 'SmartifyOS does not have a build for this processor.' 'It runs on 64 bit Intel and ARM.' }
	}
	Write-Step "your system: $target"

	$baseUrl = [Environment]::GetEnvironmentVariable('SMARTIFY_OS_BASE_URL')
	if ([string]::IsNullOrWhiteSpace($baseUrl)) {
		if ($version -eq 'latest') {
			$baseUrl = "https://github.com/$repo/releases/latest/download"
		}
		else {
			$baseUrl = "https://github.com/$repo/releases/download/$version"
		}
	}

	$archive = "$binName-$target.zip"
	$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('smartify-os-' + [System.Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $temp -Force | Out-Null

	try {
		# --- Download --------------------------------------------------------

		Write-Step "downloading $version"
		$archivePath = Join-Path $temp $archive
		try {
			Invoke-WebRequest -Uri "$baseUrl/$archive" -OutFile $archivePath -UseBasicParsing
		}
		catch {
			Write-Fail "Could not download $archive." "Check https://github.com/$repo/releases to see what is published."
		}

		# The checksum file covers every archive in the release, so pull out our line.
		$checksumsPath = Join-Path $temp 'checksums.txt'
		$haveChecksums = $true
		try {
			Invoke-WebRequest -Uri "$baseUrl/checksums.txt" -OutFile $checksumsPath -UseBasicParsing
		}
		catch {
			$haveChecksums = $false
		}

		if ($haveChecksums) {
			$pattern = "\s$([regex]::Escape($archive))$"
			$line = Get-Content $checksumsPath | Where-Object { $_ -match $pattern } | Select-Object -First 1
			if ($line) {
				$expected = ($line -split '\s+')[0]
				$actual = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash
				if ($expected -ine $actual) {
					Write-Fail 'The download does not match its checksum.' 'Something went wrong on the way. Please try again.'
				}
				Write-Ok 'checksum matches'
			}
		}

		# --- Install ---------------------------------------------------------

		Write-Step 'installing'
		Expand-Archive -Path $archivePath -DestinationPath $temp -Force

		$extracted = Join-Path $temp "$binName.exe"
		if (-not (Test-Path $extracted)) {
			Write-Fail "The download did not contain $binName.exe."
		}

		New-Item -ItemType Directory -Path $installDir -Force | Out-Null
		$installedPath = Join-Path $installDir "$binName.exe"
		Move-Item -Path $extracted -Destination $installedPath -Force
		Write-Ok "put it in $installDir"

		$reported = & $installedPath --version
		if ($LASTEXITCODE -ne 0) {
			Write-Fail 'The installed binary does not run on this machine.' "Please open an issue at https://github.com/$repo/issues"
		}
		Write-Ok "SmartifyOS CLI $reported"

		# --- Put the binary on the PATH --------------------------------------

		# The user PATH is edited, never the machine one, so this needs no admin rights.
		$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
		$alreadyOnPath = $false
		if ($userPath) {
			$alreadyOnPath = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $installDir.TrimEnd('\')) }).Count -gt 0
		}

		$pathStatus = 'ready'
		if (-not $alreadyOnPath) {
			if ([Environment]::GetEnvironmentVariable('SMARTIFY_OS_NO_MODIFY_PATH')) {
				$pathStatus = 'manual'
			}
			else {
				$newPath = if ($userPath) { "$installDir;$userPath" } else { $installDir }
				[Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
				# Also fix up this session, so the user does not have to reopen the window.
				$env:Path = "$installDir;$env:Path"
				Write-Ok 'added it to your PATH'
				$pathStatus = 'changed'
			}
		}

		Write-Host ''
		switch ($pathStatus) {
			'ready' {
				Write-Host '  All set. Run:'
				Write-Host ''
				Write-Host "    $binName" -ForegroundColor Cyan
			}
			'changed' {
				Write-Host '  Almost there. Open a new terminal, then run:'
				Write-Host ''
				Write-Host "    $binName" -ForegroundColor Cyan
			}
			'manual' {
				Write-Host '  Almost there. Add this folder to your PATH:'
				Write-Host ''
				Write-Host "    $installDir" -ForegroundColor Cyan
			}
		}
		Write-Host ''
	}
	finally {
		Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
	}
}

try {
	Invoke-SmartifyOsInstall
	$global:LASTEXITCODE = 0
}
catch {
	# Write-Fail already printed something the user can act on. Anything else is a bug,
	# so that one gets shown in full.
	if ("$_" -ne 'SmartifyOsInstallFailed') {
		Write-Host ''
		Write-Host '  ! The SmartifyOS installer ran into an unexpected problem.' -ForegroundColor Red
		Write-Host "    $_" -ForegroundColor DarkGray
		Write-Host '    Please report it at https://github.com/SmartifyOS/SmartifyOS-CLI/issues' -ForegroundColor DarkGray
		Write-Host ''
	}
	$global:LASTEXITCODE = 1
}
