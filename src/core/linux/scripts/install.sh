#!/usr/bin/env bash
#
# Sets a car up with SmartifyOS, from the USB stick this is on.
#
#   bash install.sh [--user NAME]
#
# Written by `smartify-os export installer`. Run it once, on the car, right after
# installing Linux on it. It asks for your password once. Everything after that, updates
# included, SmartifyOS does by itself.
#
#   --user NAME   the user SmartifyOS runs as, when that is not the one running this

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The helpers, and the one step every build, deploy and update runs.
# shellcheck source=linux.sh
. "$here/linux.sh"

# Where SmartifyOS lives on the car: the app, and for a car that builds itself, Flutter and
# the source it builds.
home_dir=/opt/smartify-os
# What later runs need to know about this car, which only this script can find out.
car_conf=/etc/smartify-os/car.conf

user=''
while [ $# -gt 0 ]; do
	case "$1" in
	--user) user=${2:-}; shift 2 ;;
	--user=*) user=${1#--user=}; shift ;;
	-h | --help)
		sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) fail "install.sh does not take $1." 'Run it as: bash install.sh' ;;
	esac
done

conf="$here/export.conf"
[ -f "$conf" ] || fail 'export.conf is missing next to install.sh.' 'Export the installer again with smartify-os export installer.'
[ "$(conf_get "$conf" KIND)" = installer ] ||
	fail 'This USB stick has an update on it, not an installer.' 'Plug it into a car that runs SmartifyOS already, and it offers the update by itself.'

build_on=$(conf_get "$conf" BUILD_ON)
linux_id=$(conf_get "$conf" LINUX_ID)
linux_version=$(conf_get "$conf" LINUX_VERSION_ID)
linux_name=$(conf_get "$conf" LINUX_NAME)

# -- Before anything changes -------------------------------------------------------------

[ "$(uname -s)" = Linux ] || fail 'This runs on the car, and the car runs Linux.'
command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1 ||
	fail "SmartifyOS needs a Linux that installs packages with apt, like $linux_name."

# Root, asked for once. The user who ran it is the one SmartifyOS runs as. Debian installed
# with a root password has no sudo, and its user is in no sudo group, so that asks su.
if [ "$(id -u)" -ne 0 ]; then
	user=${user:-$(id -un)}
	if command -v sudo >/dev/null 2>&1 && grep -Eqw 'sudo|admin|wheel' <<<"$(id -nG)"; then
		step 'SmartifyOS needs your password once, to set this car up'
		exec sudo -- bash "${BASH_SOURCE[0]}" --user "$user"
	fi
	step "SmartifyOS needs the root password once, to set this car up"
	exec su root -c "bash $(printf '%q' "${BASH_SOURCE[0]}") --user $(printf '%q' "$user")"
fi

if [ -z "$user" ]; then user=${SUDO_USER:-}; fi
if [ -z "$user" ] || [ "$user" = root ]; then
	if [ -t 0 ]; then
		read -r -p 'Which user does SmartifyOS run as on this car? ' user
	else
		fail 'Which user SmartifyOS runs as is not known.' 'Run this as that user, or pass --user NAME.'
	fi
fi
id "$user" >/dev/null 2>&1 || fail "There is no user called $user on this car."
[ "$user" != root ] || fail 'SmartifyOS never runs as root.' 'Pass the user it runs as with --user NAME.'
group=$(id -gn "$user")

os_id=$(conf_get /etc/os-release ID | tr -d '"')
os_version=$(conf_get /etc/os-release VERSION_ID | tr -d '"')
if [ "$os_id" != "$linux_id" ] || [ "$os_version" != "$linux_version" ]; then
	warn "This car runs $(conf_get /etc/os-release PRETTY_NAME | tr -d '"'), and SmartifyOS is made for $linux_name."
	info 'Carrying on, but what is installed below may be missing or named differently here.'
fi

arch=$(machine_arch)
[ -n "$arch" ] || fail "SmartifyOS runs on x64 and arm64 cars, this one is $(dpkg --print-architecture)."
if [ "$build_on" = computer ] && [ "$(conf_get "$conf" ARCH)" != "$arch" ]; then
	fail "This USB stick has SmartifyOS built for $(conf_get "$conf" ARCH) cars, and this car is $arch." \
		'Export the installer again, built for this car.'
fi

# -- The base system ---------------------------------------------------------------------

# Everything every car has, whatever it runs: passwordless sudo for the user SmartifyOS
# runs as, starting SmartifyOS when the car starts, and the rest of the system settings.
# Comes once the official Linux is settled.
setup_system() {
	:
}

setup_system

# -- SmartifyOS --------------------------------------------------------------------------

install -d -o "$user" -g "$group" "$home_dir"
install -d /etc/smartify-os
printf 'USER=%s\nDIR=%s\n' "$user" "$home_dir" >"$car_conf"

if [ "$build_on" = car ]; then
	bash "$here/linux.sh" packages "$here/packages/build" --user "$user"
	bash "$here/linux.sh" flutter "$(conf_get "$conf" FLUTTER_VERSION)" "$home_dir/flutter" --user "$user"

	step "Unpacking your car's app"
	rm -rf "$home_dir/source"
	install -d -o "$user" -g "$group" "$home_dir/source"
	runuser -u "$user" -- tar -xzf "$here/source.tar.gz" -C "$home_dir/source"

	bundle=$(bash "$here/linux.sh" build "$home_dir/source/app" --flutter "$home_dir/flutter" --user "$user")
	bash "$here/linux.sh" packages "$here/packages/run" --user "$user" --bundle "$bundle"
else
	step 'Unpacking SmartifyOS'
	rm -rf "$home_dir/.new"
	install -d -o "$user" -g "$group" "$home_dir/.new"
	runuser -u "$user" -- tar -xzf "$here/app.tar.gz" -C "$home_dir/.new"
	bundle="$home_dir/.new/bundle"

	bash "$here/linux.sh" packages "$here/packages/run" --user "$user"
fi

step 'Checking SmartifyOS has everything it needs to start'
bash "$here/linux.sh" check "$bundle"

step 'Putting SmartifyOS in place'
rm -rf "$home_dir/app"
if [ "$build_on" = car ]; then
	# Copied, so the build folder stays and the next build on the car is quicker.
	cp -a "$bundle" "$home_dir/app"
else
	mv "$bundle" "$home_dir/app"
	rm -rf "$home_dir/.new"
fi
chown -R "$user:$group" "$home_dir/app"

step "SmartifyOS is installed in $home_dir/app"
info 'You can unplug the USB stick.'
