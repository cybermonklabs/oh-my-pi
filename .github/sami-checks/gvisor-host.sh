#!/usr/bin/env bash
# A gVisor job's host. gVisor's runsc from a pinned release, registered with Docker as the runtime
# `runsc` on the systrap platform (systrap needs no KVM), and the proof that a container started
# with it runs on gVisor's kernel: its dmesg starts with gVisor's banner. The control: the same
# command under runc must not print that banner, so the check can fail.
# Given the reference tools tarball (tools.sh's), it then builds the test image sc-gv and checks it
# under runsc as host.sh checks a host: ubuntu 24.04 (the gate kit's image), the packages the tests
# call, the reference tools at /, the locales, the terminfo entry, and the user runner (uid 1000).
#   gvisor-host.sh [TOOLS_TGZ]
set -euo pipefail
fail() { echo "::error title=gVisor host::$*"; exit 1; }
tgz=${1:-}
# The release and its sha256. gVisor publishes a sha512 beside the tarball (gvisor.tar.zstd.sha512,
# a3426150...672c2b7d); the sha256 below is of the bytes that matched it.
GV_RELEASE=20261116.0
GV_SHA256=4eb0475337f119ae7411c1d99d3acd727f1278a0286a244dee8dac91c6db5355
# ubuntu 24.04, the image the gate kit's gVisor Jobs ran (jobs-final/itrun-gvisor.yaml).
UBUNTU=docker.io/library/ubuntu@sha256:77eb101c607d6e3d4f5ad0c8a02c2136c689b98aba1f359e6502ba517e5c57ec

d=$(mktemp -d)
url=https://storage.googleapis.com/gvisor/releases/release/$GV_RELEASE/x86_64/gvisor.tar.zstd
echo "STEP curl -fsSL -o gvisor.tar.zstd $url"
curl -fsSL --retry 3 --retry-delay 5 -o "$d/gvisor.tar.zstd" "$url"
echo "STEP sha256 $GV_SHA256"
echo "$GV_SHA256  $d/gvisor.tar.zstd" | sha256sum -c - || fail "gvisor.tar.zstd of $GV_RELEASE does not have sha256 $GV_SHA256"
# runsc, containerd-shim-runsc-v1 and gvisor-bin/ (the sidecars runsc runs from beside itself).
echo "STEP sudo tar --zstd -xf gvisor.tar.zstd -C /usr/local/bin"
sudo tar --zstd -xf "$d/gvisor.tar.zstd" -C /usr/local/bin
/usr/local/bin/runsc --version
echo "STEP sudo runsc install --download-sidecars=NEVER --require-sidecars=ALWAYS -- --platform=systrap"
sudo /usr/local/bin/runsc install --download-sidecars=NEVER --require-sidecars=ALWAYS -- --platform=systrap
echo "STEP sudo systemctl restart docker"
sudo systemctl restart docker
echo "DAEMON.JSON $(sudo cat /etc/docker/daemon.json | tr -d ' \n')"
docker info --format 'DOCKER {{.ServerVersion}} cgroup {{.CgroupDriver}} v{{.CgroupVersion}} runtimes {{range $k, $v := .Runtimes}}{{$k}} {{end}}'
[ -e /dev/kvm ] && echo "HOST /dev/kvm present (not used: systrap)" || echo "HOST no /dev/kvm (systrap does not need it)"

for _ in 1 2 3; do
	if docker pull -q "$UBUNTU"; then break; fi
	sleep 10
done
probe='dmesg | head -3; uname -a; id'
echo "STEP docker run --rm --runtime=runsc ubuntu:24.04 sh -c '$probe'"
out=$(docker run --rm --runtime=runsc "$UBUNTU" sh -c "$probe" 2>&1) || fail "runsc did not run a container: $out"
printf '%s\n' "$out" | sed 's/^/GVISOR | /'
case "${out%%$'\n'*}" in
	*"Starting gVisor"*) ;;
	*) fail "the runsc container's dmesg does not start with gVisor's banner" ;;
esac
ctl=$(docker run --rm --runtime=runc "$UBUNTU" sh -c "$probe" 2>&1) || true
printf '%s\n' "$ctl" | sed 's/^/RUNC   | /'
case "$ctl" in *"Starting gVisor"*) fail "the runc control prints gVisor's banner too, so the banner proves nothing" ;; esac
echo "GVISOR OK: runsc $GV_RELEASE, platform systrap; the runc control has no gVisor banner"

[ -n "$tgz" ] || exit 0
[ -s "$tgz" ] || fail "no reference tools tarball at $tgz: the tools job failed"
ctx=$(mktemp -d)
cp "$tgz" "$ctx/sc-tools.tgz"
# The host's apt mirror (the runner's region), else the image's own. A runner's sources name a
# mirror list (mirror+file:/etc/apt/apt-mirrors.txt) that the image does not have: take its first.
mirror=$(awk '/^URIs:/ {print $2; exit}' /etc/apt/sources.list.d/ubuntu.sources 2> /dev/null) || mirror=
case $mirror in mirror+file:*) mirror=$(awk 'NR == 1 {print $1}' "${mirror#mirror+file:}" 2> /dev/null) ;; esac
case $mirror in http://* | https://*) ;; *) mirror= ;; esac
cat > "$ctx/Dockerfile" << EOF
FROM $UBUNTU
ARG MIRROR=
RUN set -eu; [ -z "\$MIRROR" ] || sed -i "s#^URIs: .*#URIs: \$MIRROR#" /etc/apt/sources.list.d/ubuntu.sources; \\
    export DEBIAN_FRONTEND=noninteractive; \\
    apt-get -q -o Acquire::Retries=5 update; \\
    apt-get -q -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates curl git unzip xz-utils \\
      python3 perl procps psmisc findutils coreutils util-linux patch locales ncurses-bin ncurses-base ncurses-term \\
      libncursesw6 libtinfo6 libxxhash0 liblz4-1 libzstd1 libacl1 libidn2-0 strace iputils-ping openssh-client acl attr file; \\
    rm -rf /var/lib/apt/lists/*; \\
    locale-gen en_US.UTF-8 sv_SE.UTF-8 de_DE.UTF-8; \\
    userdel -r ubuntu 2> /dev/null || true; \\
    useradd -m -u 1000 -U -s /bin/bash runner
COPY sc-tools.tgz /tmp/sc-tools.tgz
RUN tar -C / --no-overwrite-dir -xzf /tmp/sc-tools.tgz && rm /tmp/sc-tools.tgz
EOF
s=$(date +%s)
docker build --progress=plain --build-arg MIRROR="$mirror" -t sc-gv "$ctx" > "$ctx/build.log" 2>&1 ||
	{ grep -v -E '^#[0-9]+ [0-9.]+ (Get|Hit|Selecting|Preparing|Unpacking|Setting up|Processing)' "$ctx/build.log" | tail -n 80; fail "the image sc-gv did not build"; }
echo "IMAGE sc-gv built in $(($(date +%s) - s)) s from $UBUNTU (apt mirror: ${mirror:-the image default})"

# host.sh's checks of the reference environment, inside a runsc container of the image, as root and
# as uid 1000; and a pty opens (the kit's first gVisor row could not open one).
docker run --rm --runtime=runsc -i sc-gv bash -s << 'EOF' || fail "the image sc-gv under runsc misses a part of the reference environment (above)"
set -euo pipefail
fail() { echo "::error title=gVisor image::$*"; exit 1; }
trap 'echo "::error title=gVisor image::line $LINENO exited $?: $BASH_COMMAND"' ERR
# The evidence is dmesg's first line, not its exit.
b=$(dmesg 2>&1) || true
case "${b%%$'\n'*}" in *"Starting gVisor"*) ;; *) fail "not gVisor: ${b%%$'\n'*}" ;; esac
v=$(/bin/zsh -fc 'print -r -- "$ZSH_VERSION $ZSH_PATCHLEVEL"' 2>&1) || true
[ "$v" = "5.9 zsh-5.9-0-g73d3173" ] || fail "/bin/zsh is '$v', not 5.9 zsh-5.9-0-g73d3173"
fp=$(/bin/zsh -fc 'print -r -- "$fpath"')
case " $fp " in *" /usr/share/zsh/5.9/functions "*) ;; *) fail "zsh's fpath is '$fp'" ;; esac
for f in history-search-end compinit _main_complete _kill; do
	[ -f "/usr/share/zsh/5.9/functions/$f" ] || fail "no /usr/share/zsh/5.9/functions/$f"
done
/bin/zsh -fc 'zmodload zsh/curses && zmodload zsh/terminfo && zmodload zsh/complist && zmodload zsh/zle' ||
	fail "zsh/curses, zsh/terminfo, zsh/complist or zsh/zle does not load"
la=$(locale -a)
for l in en_US.utf8 sv_SE.utf8 de_DE.utf8; do
	case $'\n'"$la"$'\n' in *$'\n'"$l"$'\n'*) ;; *) fail "the locale $l is not generated" ;; esac
done
mb=$(env LANG=en_US.UTF-8 /bin/zsh -fc 'print ${#${:-é漢}}')
[ "$mb" = 2 ] || fail "zsh in en_US.UTF-8 counts 'é漢' as '$mb' characters, not 2"
infocmp xterm-256color > /dev/null 2>&1 || fail "no terminfo entry xterm-256color"
# Whole outputs, then their first line: under pipefail, `| head -n 1` fails the writer with
# SIGPIPE when head exits first, as rsync --version did under gVisor.
r=$(/opt/sc-ref/bin/rsync --version)
r=${r%%$'\n'*}
case "$r" in "rsync  version 3.5.1  protocol version 33"*) ;; *) fail "the reference rsync is '$r'" ;; esac
j=$(/opt/sc-ref/bin/jj --version)
case "$j" in "jj 0.46.0"*) ;; *) fail "the reference jj is '$j'" ;; esac
[ "$(id -u runner)" = 1000 ] || fail "the user runner is not uid 1000"
for c in setpriv timeout python3 git ping ssh localedef; do command -v "$c" > /dev/null || fail "no $c in the image"; done
python3 -c 'import os; os.openpty()' || fail "root cannot open a pty"
setpriv --reuid=1000 --regid=1000 --clear-groups python3 -c 'import os; os.openpty()' || fail "uid 1000 cannot open a pty"
echo "IMAGE zsh=[$v] rsync=[$r] jj=[$j] bash=[$(bv=$(/bin/bash --version) && echo "${bv%%$'\n'*}")] locales en_US sv_SE de_DE; pty ok as root and uid 1000; kernel=[$(uname -r)] cpus=$(nproc)"
EOF
