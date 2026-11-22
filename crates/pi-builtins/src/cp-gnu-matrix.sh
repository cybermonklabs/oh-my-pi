#!/usr/bin/env bash
# Writes cp-gnu-matrix.txt: runs one GNU coreutils build's cp across the probe matrix of
# `cp_does_what_gnu_does_across_the_probe_matrix` (cp.rs) and prints one tab-separated row per case: id, setup,
# arguments, standard input, exit status, standard error (each newline written as \n), and the entries after
# the run (find | sort, subdirectories included): a regular file as name=contents#links, a symbolic link as
# name=link:target, a directory as name=dir. A row whose cp wrote to standard output is marked STDOUT.
#
# The committed rows are GNU coreutils 9.7's cp on a Linux kernel, run as uid 1000 on a filesystem that cannot
# clone (ext4 or tmpfs; cp's defaults do not clone there):
#   TMPDIR=<scratch> bash cp-gnu-matrix.sh <coreutils-9.7/src> > cp-gnu-matrix.txt
# Root gives the same rows. GNU 9.4 gives the same rows but for leaving the source's name out of "cannot
# overwrite directory 'a~' with non-directory". The `cp -R d d` rows change from run to run (GNU copies part of
# d into d/d first, in the order it reads d); cp.rs states them.
#
# Setup steps, in order: C>name writes C to name; target@name makes a symbolic link; ln:a=b makes b another
# hard link of a; dir:d makes a directory. Then every entry's own times are set to 1000000000, and a step
# T:name=secs sets name's times (following a link) to secs. <D> in an argument is the case's directory.
#
# Usage: cp-gnu-matrix.sh <directory holding cp>
#   CPMATRIX_LIST=1 prints the row ids in order and runs nothing.
#   CPMATRIX_SHARD=k/n runs only the scenarios whose index is k modulo n (merge the shards in the CPMATRIX_LIST
#   order).
set -u
BIN=${1:-}
list=${CPMATRIX_LIST:-}
shard=${CPMATRIX_SHARD:-0/1}
shard_k=${shard%/*} shard_n=${shard#*/}
if [ -z "$list" ]; then
	[ -x "$BIN/cp" ] || { echo "usage: $0 <directory holding cp>" >&2; exit 2; }
	W=$(mktemp -d "${TMPDIR:-/tmp}/cpmatrix.XXXXXX") || exit 3
fi
state() {
	local out="" f
	while IFS= read -r f; do
		f=${f#./}
		if [ -L "$f" ]; then out+=" $f=link:$(readlink "$f")"
		elif [ -d "$f" ]; then out+=" $f=dir"
		else out+=" $f=$(cat "$f")#$(stat -c %h "$f")"; fi
	done < <(find . -mindepth 1 | LC_ALL=C sort)
	echo "$out"
}
n=0
case_run() { # case_run <id> <setup> <args> <stdin>
	local id=$1 setup=$2 args=$3 input=$4 d step out code st dirty
	if [ -n "$list" ]; then
		echo "$id"
		return
	fi
	n=$((n + 1))
	d=$W/$n
	mkdir "$d" && cd "$d" || exit 3
	umask 022
	for step in $setup; do
		case "$step" in
		T:*) ;;
		dir:*) mkdir "${step#dir:}" || exit 3 ;;
		ln:*) step=${step#ln:}; ln "${step%%=*}" "${step#*=}" || exit 3 ;;
		*'>'*) printf '%s' "${step%%>*}" > "${step#*>}" || exit 3 ;;
		*'@'*) ln -s "${step%%@*}" "${step#*@}" || exit 3 ;;
		*) echo "bad step $step" >&2; exit 3 ;;
		esac
	done
	find . -mindepth 1 -exec touch -h -d @1000000000 {} + || exit 3
	for step in $setup; do
		case "$step" in T:*) step=${step#T:}; touch -d "@${step#*=}" "${step%%=*}" || exit 3 ;; esac
	done
	local argv=()
	for a in $args; do argv+=("${a//<D>/$d}"); done
	if [ -n "$input" ]; then
		printf '%s\n' "$input" | timeout 5 "$BIN/cp" "${argv[@]}" 2> "$W/stderr.$n" > "$W/stdout.$n"
		code=${PIPESTATUS[1]}
	else
		timeout 5 "$BIN/cp" "${argv[@]}" < /dev/null 2> "$W/stderr.$n" > "$W/stdout.$n"
		code=$?
	fi
	dirty=""
	[ -s "$W/stdout.$n" ] && dirty=" STDOUT"
	# The exact bytes, trailing newlines kept: a prompt has none.
	out=$(cat "$W/stderr.$n"; printf x)
	out=${out%x}
	out=${out//$BIN\//}
	out=${out//$d/<D>}
	out=${out//$'\n'/\\n}
	st=$(state)
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$setup" "$args" "$input" "$code$dirty" "$out" "$st"
	cd "$W" || exit 3
	rm -rf -- "$d" "$W/stderr.$n" "$W/stdout.$n"
}

# Scenarios: id | setup | operands | the source to make newer for -u rows.
scenarios=(
	"own-same|A>a|a a|a"
	"own-same-bk|A>a old>a~|a a|a"
	"own-dot|A>a|a ./a|a"
	"own-cwd|A>a|a .|a"
	"own-abs|A>a|<D>/a a|a"
	"own-sub|dir:d A>d/a|d/a d|d/a"
	"own-sub-bk|dir:d A>d/a old>d/a~|d/a d|d/a"
	"own-sub-t|dir:d A>d/a old>d/a~|-t d d/a|d/a"
	"own-sub-abs|dir:d A>d/a old>d/a~|d/a <D>/d|d/a"
	"own-dslash|dir:d A>d/a|d//a d/a|d/a"
	"new|A>a|a b|a"
	"other|A>a B>b|a b|a"
	"hard|A>a ln:a=b|a b|a"
	"link-to-src|A>a a@l|a l|a"
	"link-to-other|A>a B>b b@l|a l|a"
	"dangling|A>a missing@l|a l|a"
	"into-dir|A>a dir:d|a d|a"
	"into-dir-ex|A>a dir:d B>d/a|a d|a"
	"src-l-same|A>a a@l|l l|a"
	"src-l-dot|A>a a@l|l ./l|a"
	"src-l-target|A>a a@l|l a|a"
	"src-l-other|A>a a@l B>b|l b|a"
	"src-l-new|A>a a@l|l b|a"
	"src-dangling|missing@l|l b|"
	"src-l-into-dir|A>a a@l dir:d|l d|a"
	"own-same-bk-link|A>a O>o o@a~|a a|a"
	"own-same-bk-dir|A>a dir:a~|a a|a"
	"three-links|A>a ln:a=b ln:a=c|a b|a"
	"dir-self|dir:d A>d/f|d d|"
	"dir-self-t|dir:d A>d/f|-t d d|"
	"hard-other|A>a B>c ln:c=b|a b|a"
	"hard-other-in-dir|A>a dir:d B>c ln:c=d/a|a d|a"
	"tree-hard-other|dir:s A>s/a dir:t dir:t/s B>c ln:c=t/s/a|s t|s/a"
)
# Flag sets: the modifiers (id | options | standard input | newer source, 1 or 0) crossed with the ways of
# replacing a destination (id | options). A modifier with -u and no newer source leaves the source as old as
# the destination, so -u skips; with a newer source -u goes on.
modifiers=(
	"|||0" "P|-P||0" "L|-L||0" "R|-R||0" "l|-l||0" "s|-s||0" "iy|-i|y|0" "in|-i|n|0" "u|-u||0" "un|-u||1"
	"u-l|-u -l||0" "un-l|-u -l||1" "u-s|-u -s||0" "un-s|-u -s||1"
	"ao|--attributes-only||0" "u-ao|-u --attributes-only||0" "un-ao|-u --attributes-only||1"
	"l-iy|-l -i|y|0" "l-in|-l -i|n|0" "u-iy|-u -i|y|0" "un-iy|-u -i|y|1" "un-in|-u -i|n|1"
	"u-l-iy|-u -l -i|y|0" "un-l-iy|-u -l -i|y|1" "un-l-in|-u -l -i|n|1"
	"u-R|-R -u||0" "un-R|-R -u||1" "a|-a||0" "d|-d||0" "pl|--preserve=links||0"
	"u-R-l|-R -u -l||0" "un-R-l|-R -u -l||1"
)
replacing=(
	"|" "f|-f" "rd|--remove-destination" "rdf|--remove-destination -f" "frd|-f --remove-destination"
	"b|-b" "fb|-f -b" "rdb|--remove-destination -b" "rdfb|--remove-destination -f -b"
	"frdb|-f --remove-destination -b" "bn|--backup=numbered" "fbn|-f --backup=numbered"
)
flagsets=()
for m in "${modifiers[@]}"; do
	IFS='|' read -r mid mflags input isnewer <<< "$m"
	for r in "${replacing[@]}"; do
		IFS='|' read -r rid rflags <<< "$r"
		id=$mid${mid:+${rid:+-}}$rid
		flags=$mflags${mflags:+${rflags:+ }}$rflags
		flagsets+=("${id:-plain}|$flags|$input|$isnewer")
	done
done
index=0
for s in "${scenarios[@]}"; do
	index=$((index + 1))
	[ -n "$list" ] || [ $(((index - 1) % shard_n)) = "$shard_k" ] || continue
	IFS='|' read -r sid setup operands newer <<< "$s"
	for f in "${flagsets[@]}"; do
		IFS='|' read -r fid flags input isnewer <<< "$f"
		steps=$setup
		if [ "$isnewer" = 1 ]; then
			[ -n "$newer" ] || continue
			steps+=" T:$newer=2000000000"
		fi
		case_run "$sid/$fid" "$steps" "${flags:+$flags }$operands" "$input"
	done
done
[ -n "$list" ] || { cd / && rm -rf -- "$W"; }
