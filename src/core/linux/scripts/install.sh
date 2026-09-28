#!/usr/bin/env bash
#
# Sets a car up with SmartifyOS, from the USB stick this is on.
#
#   bash install.sh [--user NAME] [--yes] [--no-restart]
#
# Written by `smartify-os export installer`. Run it once, on the car, right after
# installing Linux on it. It asks for your password once. Everything after that, updates
# included, SmartifyOS does by itself.
#
#   --user NAME    the user SmartifyOS runs as, when that is not the one running this
#   -y, --yes      asks nothing, and restarts the car when it is done
#   --no-restart   leaves restarting the car to you

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
# Everything the steps print, for when one fails.
log=/var/log/smartify-os-install.log

# -- How it looks -------------------------------------------------------------------------
#
# Drawn the way the smartify-os CLI draws itself (clack): a line down the left, one symbol
# per step, a spinner while one runs. Plain lines when nobody is watching. The Linux
# console cannot draw most of the symbols, so it gets the same ASCII ones clack uses there.

ui=0
if [ -t 2 ] && [ "${TERM:-dumb}" != dumb ]; then ui=1; fi

if [ "$ui" -eq 1 ] && [ -z "${NO_COLOR:-}" ]; then
	u_gray=$'\033[90m' u_dim=$'\033[2m' u_bold=$'\033[1m' u_cyan=$'\033[36m' u_green=$'\033[32m'
	u_yellow=$'\033[33m' u_red=$'\033[31m' u_blue=$'\033[34m' u_magenta=$'\033[35m' u_off=$'\033[0m'
else
	u_gray='' u_dim='' u_bold='' u_cyan='' u_green='' u_yellow='' u_red='' u_blue='' u_magenta='' u_off=''
fi

if [ "${TERM:-}" = linux ]; then
	s_start='+' s_bar='|' s_end='+' s_done='o' s_active='*' s_info='*' s_warn='!' s_error='x'
	s_on='>' s_off=' '
	frames=('|' '/' '-' '\')
else
	s_start='┌' s_bar='│' s_end='└' s_done='◇' s_active='◆' s_info='●' s_warn='▲' s_error='■'
	s_on='●' s_off='○'
	frames=('◒' '◐' '◓' '◑')
fi

bar="$u_gray$s_bar$u_off"

# say <symbol> <text> [line...]: one finished message, and the lines that go with it.
say() {
	local symbol=$1 text=$2 line
	shift 2
	printf '%s\n%s  %s\n' "$bar" "$symbol" "$text" >&2
	for line in "$@"; do printf '%s  %s\n' "$bar" "$line" >&2; done
}

intro() {
	if [ "$ui" -eq 0 ]; then step "$1"; return; fi
	printf '%s%s%s  %s%sSmartifyOS%s %s·%s %s\n' "$u_gray" "$s_start" "$u_off" "$u_cyan" "$u_bold" "$u_off" "$u_dim" "$u_off" "$1" >&2
}

outro() {
	if [ "$ui" -eq 0 ]; then step "$1"; return; fi
	printf '%s\n%s%s%s  %s\n\n' "$bar" "$u_gray" "$s_end" "$u_off" "$1" >&2
}

# note <text> [dim line...]
note() {
	local text=$1 line
	shift
	if [ "$ui" -eq 0 ]; then
		step "$text"
		for line in "$@"; do info "$line"; done
		return
	fi
	local lines=()
	for line in "$@"; do lines+=("$u_dim$line$u_off"); done
	say "$u_blue$s_info$u_off" "$text" ${lines[@]+"${lines[@]}"}
}

caution() {
	if [ "$ui" -eq 0 ]; then warn "$1"; else say "$u_yellow$s_warn$u_off" "$u_yellow$1$u_off"; fi
}

finished() {
	if [ "$ui" -eq 0 ]; then step "$1"; else say "$u_green$s_done$u_off" "$1"; fi
}

# stop <what went wrong> [what to do about it]: the end of the install.
stop() {
	if [ "$ui" -eq 0 ]; then fail "$@"; fi
	say "$u_red$s_error$u_off" "$u_red$1$u_off" ${2:+"$u_dim$2$u_off"}
	outro 'SmartifyOS is not installed yet. Run this again once that is sorted.'
	exit 1
}

cancelled() {
	if [ "$ui" -eq 0 ]; then fail 'Cancelled, nothing was changed.'; fi
	outro "${u_red}Cancelled, nothing was changed.$u_off"
	exit 1
}

show_cursor() {
	if [ "$ui" -eq 1 ]; then printf '\033[?25h' >&2; fi
}

# The step running now, stopped with the install when someone presses Ctrl+C.
task_pid=''

interrupted() {
	trap - INT TERM
	if [ -n "$task_pid" ]; then
		kill "$task_pid" 2>/dev/null || true
		wait "$task_pid" 2>/dev/null || true
		if [ "$ui" -eq 1 ]; then printf '\r\033[J' >&2; fi
	fi
	show_cursor
	if [ "$ui" -eq 1 ]; then
		say "$u_red$s_error$u_off" 'Stopped.'
		outro 'Run this again to finish setting up the car.'
	else
		warn 'Stopped. Run this again to finish setting up the car.'
	fi
	exit 130
}
trap interrupted INT TERM
trap show_cursor EXIT

# The width of the terminal, to keep a line on one line.
columns() {
	local cols
	cols=$(tput cols 2>/dev/null || true)
	case "$cols" in '' | *[!0-9]*) echo 80 ;; *) echo "$cols" ;; esac
}

esc=$'\033'

# The log from a byte on, with colors and progress bars' carriage returns taken out.
log_since() {
	tail -c +"$(($1 + 1))" "$log" | tr '\r' '\n' | sed "s/$esc\[[0-9;?]*[A-Za-z]//g"
}

# The last thing a running step printed, shortened to fit.
latest_line() {
	local offset=$1 width=$2 size line
	size=$(wc -c <"$log" | tr -d ' ')
	# Only the end of a long log, so reading it stays quick.
	if [ $((size - offset)) -gt 4000 ]; then offset=$((size - 4000)); fi
	line=$(log_since "$offset" | awk 'NF { line = $0 } END { print line }')
	line=${line#==> }
	line=${line#"${line%%[![:space:]]*}"}
	if [ "${#line}" -gt "$width" ]; then line="${line:0:$((width - 3))}..."; fi
	printf '%s' "$line"
}

# How long something took, for a person: 45s, 3m 20s.
took() {
	local seconds=$1
	if [ "$seconds" -lt 60 ]; then printf '%ss' "$seconds"; else printf '%sm %ss' $((seconds / 60)) $((seconds % 60)); fi
}

# What a step printed on stdout, once it is done.
task_out=''

# task <title> <done title> <command>...: runs one step, with a spinner and the last thing
# it printed while it does. Everything else it prints goes to the log, and when it fails,
# what went wrong is read out of it: the two lines `fail` in linux.sh ends with.
task() {
	local title=$1 done_title=$2
	shift 2
	printf '\n== %s\n' "$title" >>"$log"
	if [ "$ui" -eq 0 ]; then
		step "$title"
		"$@" </dev/null >"$task_out"
		return
	fi

	local offset start elapsed status frame=0 width detail clock line
	offset=$(wc -c <"$log" | tr -d ' ')
	start=$SECONDS
	width=$(($(columns) - 4))
	printf '\033[?25l%s\n' "$bar" >&2
	# The step's own messages go to the log without colors, so they read as plain lines. It
	# gets no terminal to read from either: apt puts the one it is given into raw mode while
	# dpkg runs, which would break the drawing.
	(
		c_step='' c_warn='' c_err='' c_dim='' c_off=''
		"$@"
	) </dev/null >"$task_out" 2>>"$log" &
	task_pid=$!
	while kill -0 "$task_pid" 2>/dev/null; do
		elapsed=$((SECONDS - start))
		clock=''
		if [ "$elapsed" -ge 5 ]; then clock=" $u_dim($(took "$elapsed"))$u_off"; fi
		detail=$(latest_line "$offset" "$width")
		printf '\r\033[K%s%s%s  %s%s\n\033[K%s  %s%s%s\033[1A\r' \
			"$u_magenta" "${frames[$((frame % 4))]}" "$u_off" "$title" "$clock" \
			"$bar" "$u_dim" "$detail" "$u_off" >&2
		frame=$((frame + 1))
		sleep 0.1
	done
	if wait "$task_pid"; then status=0; else status=$?; fi
	task_pid=''
	elapsed=$((SECONDS - start))
	printf '\r\033[J\033[?25h' >&2

	local printed
	printed=$(log_since "$offset")
	if [ "$status" -eq 0 ]; then
		clock=''
		if [ "$elapsed" -ge 10 ]; then clock="  $u_dim$(took "$elapsed")$u_off"; fi
		printf '%s  %s%s\n' "$u_green$s_done$u_off" "$done_title" "$clock" >&2
		# What it warned about is worth reading even when it worked.
		while IFS= read -r line; do
			if [ -n "$line" ]; then say "$u_yellow$s_warn$u_off" "$u_yellow${line#  ! }$u_off"; fi
		done <<<"$(grep '^  ! ' <<<"$printed" || true)"
		return 0
	fi

	local what hint context
	what=$(awk '/^  x / { line = substr($0, 5) } END { print line }' <<<"$printed")
	hint=$(awk '/^  x / { found = 1; hint = ""; next } found && /^    / && hint == "" { hint = substr($0, 5); found = 0; next } { found = 0 } END { print hint }' <<<"$printed")
	# The end of what it printed before the error, which is said below it.
	context=$(awk '/^  x / { exit } NF { sub(/^==> /, ""); print }' <<<"$printed" | tail -n 12)
	printf '%s  %s\n' "$u_red$s_warn$u_off" "$u_red$title$u_off" >&2
	if [ -n "$context" ]; then
		while IFS= read -r line; do
			if [ "${#line}" -gt "$width" ]; then line="${line:0:$((width - 3))}..."; fi
			printf '%s  %s%s%s\n' "$bar" "$u_dim" "$line" "$u_off" >&2
		done <<<"$context"
	fi
	printf '%s  %s\n' "$bar" "${u_dim}Everything it printed is in $log$u_off" >&2
	stop "${what:-$title did not work.}" "${hint:-The lines above say why.}"
}

# confirm <question> <yes|no> [line...]: a yes or no question, answered with the arrow keys
# and Enter, or y and n. Says whether the answer was yes.
confirm() {
	local question=$1 answer=$2 key rest line lines=0
	shift 2
	if [ "$ui" -eq 0 ]; then
		for line in "$@"; do info "$line"; done
		local hint='[Y/n]'
		if [ "$answer" = no ]; then hint='[y/N]'; fi
		read -r -p "$question $hint " key
		case "$key" in [yY]*) return 0 ;; [nN]*) return 1 ;; *) [ "$answer" = yes ] ;; esac
		return
	fi

	printf '%s\n' "$bar" >&2
	while :; do
		local yes="$u_dim$s_off Yes$u_off" no="$u_dim$s_off No$u_off"
		if [ "$answer" = yes ]; then yes="$u_green$s_on$u_off Yes"; else no="$u_green$s_on$u_off No"; fi
		if [ "$lines" -gt 0 ]; then printf '\033[%sA\r\033[J' "$lines" >&2; fi
		printf '%s  %s\n' "$u_cyan$s_active$u_off" "$question" >&2
		lines=1
		for line in "$@"; do
			printf '%s  %s%s%s\n' "$u_cyan$s_bar$u_off" "$u_dim" "$line" "$u_off" >&2
			lines=$((lines + 1))
		done
		printf '%s  %s %s/%s %s\n%s\n' "$u_cyan$s_bar$u_off" "$yes" "$u_dim" "$u_off" "$no" "$u_cyan$s_end$u_off" >&2
		lines=$((lines + 2))

		IFS= read -rsn1 key || key=''
		case "$key" in
		'') break ;;
		y | Y) answer=yes; break ;;
		n | N) answer=no; break ;;
		"$esc")
			IFS= read -rsn2 rest || rest=''
			case "$rest" in '[C' | '[D' | '[A' | '[B') if [ "$answer" = yes ]; then answer=no; else answer=yes; fi ;; esac
			;;
		h | l | ' ' | $'\t') if [ "$answer" = yes ]; then answer=no; else answer=yes; fi ;;
		esac
	done

	printf '\033[%sA\r\033[J' "$lines" >&2
	local shown=Yes
	if [ "$answer" = no ]; then shown=No; fi
	printf '%s  %s\n%s  %s%s%s\n' "$u_green$s_done$u_off" "$question" "$bar" "$u_dim" "$shown" "$u_off" >&2
	[ "$answer" = yes ]
}

# choose <question> <option>...: one of the options, picked with the arrow keys and Enter,
# into $choice.
choice=''
choose() {
	local question=$1 at=0 key rest option i lines=0
	shift
	local options=("$@")
	if [ "$ui" -eq 0 ]; then
		i=1
		for option in "${options[@]}"; do info "$i) $option"; i=$((i + 1)); done
		while :; do
			read -r -p "$question [1-${#options[@]}] " key
			case "$key" in '' | *[!0-9]*) continue ;; esac
			if [ "$key" -ge 1 ] && [ "$key" -le "${#options[@]}" ]; then
				choice=${options[$((key - 1))]}
				return
			fi
		done
	fi

	printf '%s\n' "$bar" >&2
	while :; do
		if [ "$lines" -gt 0 ]; then printf '\033[%sA\r\033[J' "$lines" >&2; fi
		printf '%s  %s\n' "$u_cyan$s_active$u_off" "$question" >&2
		i=0
		for option in "${options[@]}"; do
			if [ "$i" -eq "$at" ]; then
				printf '%s  %s %s\n' "$u_cyan$s_bar$u_off" "$u_green$s_on$u_off" "$option" >&2
			else
				printf '%s  %s%s %s%s\n' "$u_cyan$s_bar$u_off" "$u_dim" "$s_off" "$option" "$u_off" >&2
			fi
			i=$((i + 1))
		done
		printf '%s\n' "$u_cyan$s_end$u_off" >&2
		lines=$((${#options[@]} + 2))

		IFS= read -rsn1 key || key=''
		case "$key" in
		'') break ;;
		"$esc")
			IFS= read -rsn2 rest || rest=''
			case "$rest" in
			'[A') at=$(((at + ${#options[@]} - 1) % ${#options[@]})) ;;
			'[B') at=$(((at + 1) % ${#options[@]})) ;;
			esac
			;;
		k) at=$(((at + ${#options[@]} - 1) % ${#options[@]})) ;;
		j | $'\t') at=$(((at + 1) % ${#options[@]})) ;;
		esac
	done

	choice=${options[$at]}
	printf '\033[%sA\r\033[J' "$lines" >&2
	printf '%s  %s\n%s  %s%s%s\n' "$u_green$s_done$u_off" "$question" "$bar" "$u_dim" "$choice" "$u_off" >&2
}

# -- What to do ---------------------------------------------------------------------------

user=''
yes=0
restart=ask
while [ $# -gt 0 ]; do
	case "$1" in
	--user) user=${2:-}; shift 2 ;;
	--user=*) user=${1#--user=}; shift ;;
	-y | --yes) yes=1; shift ;;
	--no-restart) restart=no; shift ;;
	-h | --help)
		sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) stop "install.sh does not take $1." 'Run it as: bash install.sh' ;;
	esac
done

# Set when this runs again as root, after asking for the password, which was after the rest
# of the questions. Only this script sets it.
continued=${SMARTIFY_OS_INSTALL_CONTINUED:-0}

if [ "$continued" != 1 ]; then intro 'Setting up this car'; fi

conf="$here/export.conf"
[ -f "$conf" ] || stop 'export.conf is missing next to install.sh.' 'Export the installer again with smartify-os export installer.'
[ "$(conf_get "$conf" KIND)" = installer ] ||
	stop 'This USB stick has an update on it, not an installer.' 'Plug it into a car that runs SmartifyOS already, and it offers the update by itself.'

build_on=$(conf_get "$conf" BUILD_ON)
app_name=$(conf_get "$conf" APP)
linux_id=$(conf_get "$conf" LINUX_ID)
linux_version=$(conf_get "$conf" LINUX_VERSION_ID)
linux_name=$(conf_get "$conf" LINUX_NAME)

# -- Before anything changes ----------------------------------------------------------------

[ "$(uname -s)" = Linux ] || stop 'This runs on the car, and the car runs Linux.'
command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1 ||
	stop "SmartifyOS needs a Linux that installs packages with apt, like $linux_name."

arch=$(machine_arch)
[ -n "$arch" ] || stop "SmartifyOS runs on x64 and arm64 cars, this one is $(dpkg --print-architecture)."
if [ "$build_on" = computer ] && [ "$(conf_get "$conf" ARCH)" != "$arch" ]; then
	stop "This USB stick has SmartifyOS built for $(conf_get "$conf" ARCH) cars, and this car is $arch." \
		'Export the installer again, built for this car.'
fi

# The people who can log in, who SmartifyOS could run as.
people() {
	getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 && $7 !~ /(nologin|false)$/ { print $1 }'
}

if [ -z "$user" ]; then
	if [ "$(id -u)" -ne 0 ]; then
		user=$(id -un)
	elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
		user=$SUDO_USER
	else
		found=$(people)
		if [ -z "$found" ]; then
			stop 'There is nobody on this car SmartifyOS could run as, and it never runs as root.' \
				'Add a user with: adduser NAME, then run this again.'
		elif [ "$(wc -l <<<"$found")" -eq 1 ]; then
			user=$found
		elif [ -t 0 ] && [ "$yes" -eq 0 ]; then
			# shellcheck disable=SC2046
			choose 'Which user does SmartifyOS run as?' $found
			user=$choice
		else
			stop 'Which user SmartifyOS runs as is not known.' 'Run this as that user, or pass --user NAME.'
		fi
	fi
fi
id "$user" >/dev/null 2>&1 || stop "There is no user called $user on this car."
[ "$user" != root ] || stop 'SmartifyOS never runs as root.' 'Pass the user it runs as with --user NAME.'
group=$(id -gn "$user")

if [ "$continued" != 1 ]; then
	os_name=$(conf_get /etc/os-release PRETTY_NAME | tr -d '"')
	os_id=$(conf_get /etc/os-release ID | tr -d '"')
	os_version=$(conf_get /etc/os-release VERSION_ID | tr -d '"')
	if [ "$os_id" != "$linux_id" ] || [ "$os_version" != "$linux_version" ]; then
		caution "This car runs $os_name, and SmartifyOS is made for $linux_name. What it installs may be missing or named differently here."
	fi

	how='SmartifyOS comes ready to run.'
	if [ "$build_on" = car ]; then how='SmartifyOS is built on the car, which takes a while the first time.'; fi
	app_title=$app_name
	if [ -z "$app_title" ]; then app_title="your car's app"; fi
	note "Installing $app_title on $os_name ($arch), to run as $user" "$how" 'The car needs the internet while it installs.'

	if [ "$yes" -eq 0 ]; then
		[ -t 0 ] || stop 'Nobody is here to say yes to setting up this car.' 'Run it again with --yes.'
		confirm 'Set this computer up as a car?' yes \
			'From now on it starts straight into SmartifyOS, with no desktop or login screen.' ||
			cancelled
	fi
fi

# Root, asked for once. Debian installed with a root password has no sudo, and its user is
# in no sudo group, so that asks su.
if [ "$(id -u)" -ne 0 ]; then
	again=(--user "$user")
	if [ "$yes" -eq 1 ]; then again+=(--yes); fi
	if [ "$restart" = no ]; then again+=(--no-restart); fi
	if command -v sudo >/dev/null 2>&1 && grep -Eqw 'sudo|admin|wheel' <<<"$(id -nG)"; then
		note 'Setting it up needs your password, once.'
		prompt='[sudo] password for %u: '
		if [ "$ui" -eq 1 ]; then prompt="$bar  Password for %u: "; fi
		exec sudo -p "$prompt" -- env SMARTIFY_OS_INSTALL_CONTINUED=1 bash "${BASH_SOURCE[0]}" "${again[@]}"
	fi
	note 'Setting it up needs the root password, once.'
	exec su root -c "env SMARTIFY_OS_INSTALL_CONTINUED=1 bash $(printf '%q ' "${BASH_SOURCE[0]}" "${again[@]}")"
fi

# -- SmartifyOS ---------------------------------------------------------------------------

printf '== SmartifyOS installer, %s, for %s\n' "$(date)" "$user" >>"$log"
task_out=$(mktemp)
trap 'rm -f "$task_out"; show_cursor' EXIT

install -d -o "$user" -g "$group" "$home_dir"
install -d /etc/smartify-os
printf 'USER=%s\nDIR=%s\n' "$user" "$home_dir" >"$car_conf"

linux_sh() {
	bash "$here/linux.sh" "$@"
}

unpack_source() {
	rm -rf "$home_dir/source"
	install -d -o "$user" -g "$group" "$home_dir/source"
	runuser -u "$user" -- tar -xzf "$here/source.tar.gz" -C "$home_dir/source"
}

unpack_build() {
	rm -rf "$home_dir/.new"
	install -d -o "$user" -g "$group" "$home_dir/.new"
	runuser -u "$user" -- tar -xzf "$here/app.tar.gz" -C "$home_dir/.new"
}

# Swaps the new build in, and links what the service starts to the program in it.
put_in_place() {
	local binary
	binary=$(conf_get "$conf" BINARY)
	rm -rf "$home_dir/app"
	if [ "$build_on" = car ]; then
		# Copied, so the build folder stays and the next build on the car is quicker.
		cp -a "$bundle" "$home_dir/app"
	else
		mv "$bundle" "$home_dir/app"
		rm -rf "$home_dir/.new"
	fi
	# The service starts $home_dir/app/smartify-os, whatever the car's app calls its program,
	# so it never has to change. SmartifyOS makes the same link with every update.
	if [ -n "$binary" ] && [ "$binary" != smartify-os ]; then
		[ -f "$home_dir/app/$binary" ] ||
			fail "The build has no program called $binary." 'Export the installer again.'
		ln -sfn "$binary" "$home_dir/app/smartify-os"
	fi
	chown -R "$user:$group" "$home_dir/app"
}

if [ "$build_on" = car ]; then
	flutter_version=$(conf_get "$conf" FLUTTER_VERSION)
	task 'Installing what building SmartifyOS needs' 'Installed what building SmartifyOS needs' \
		linux_sh packages "$here/packages/build" --user "$user"
	task "Installing Flutter $flutter_version, which takes a while" "Installed Flutter $flutter_version" \
		linux_sh flutter "$flutter_version" "$home_dir/flutter" --user "$user"
	task "Unpacking your car's app" "Unpacked your car's app" unpack_source
	task 'Building SmartifyOS, which takes a few minutes' 'Built SmartifyOS' \
		linux_sh build "$home_dir/source/app" --flutter "$home_dir/flutter" --user "$user"
	# The build prints where it is as its last line.
	bundle=$(tail -n 1 "$task_out")
	task 'Installing what SmartifyOS needs' 'Installed what SmartifyOS needs' \
		linux_sh packages "$here/packages/run" --user "$user" --bundle "$bundle"
else
	task 'Unpacking SmartifyOS' 'Unpacked SmartifyOS' unpack_build
	bundle="$home_dir/.new/bundle"
	task 'Installing what SmartifyOS needs' 'Installed what SmartifyOS needs' \
		linux_sh packages "$here/packages/run" --user "$user"
fi

task 'Checking SmartifyOS has everything it needs to start' 'SmartifyOS has everything it needs to start' \
	linux_sh check "$bundle"
task 'Putting SmartifyOS in place' "Put SmartifyOS in $home_dir/app" put_in_place
task 'Setting the car up to start SmartifyOS' 'The car starts straight into SmartifyOS, from now on' \
	linux_sh system

note 'You can unplug the USB stick.' \
	'Ctrl+Alt+F2 on a keyboard plugged into the car opens a terminal, if you ever need one.'

if [ "$restart" = ask ]; then
	if [ "$yes" -eq 1 ]; then
		restart=yes
	elif [ -t 0 ] && confirm 'Restart the car now, into SmartifyOS?' yes; then
		restart=yes
	fi
fi
if [ "$restart" = yes ]; then
	outro 'SmartifyOS is installed. Restarting the car...'
	systemctl reboot
else
	outro 'SmartifyOS is installed, and starts the next time the car does.'
fi
