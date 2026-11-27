# Changelog

## [Unreleased]

### Added

- Added `TtyWriter.discard()`, which drops terminal output that was queued but not yet written; the chunk already being written still finishes ([#13794](https://github.com/can1357/oh-my-pi/pull/13794) by [@sjawhar](https://github.com/sjawhar)).
- Added `readFileBeneath()`, which reads a file a `glob` listed below the directory the glob walked without following a symlink the walk did not list; one open checks the size against `maxBytes`, probes the first `binaryProbeBytes` bytes for a NUL byte, and returns the bytes (only the first `prefixBytes` when set), reading each byte once. A file whose size the allocator refuses (beyond the address space, or above memory where overcommit is limited) and that no `maxBytes` skips is rejected with `out of memory`
- Added `GlobMatch.symlink`, set when the listing shows a symbolic link at the match (reported as `Symlink`, or as its target under a `File` or `Dir` filter); pass it to `readFileBeneath()` as `followSymlink`, which then follows that listed link wherever it points when the file is read, inside the walked directory or out of it

### Changed

- A directory walk that does not follow symlinks no longer reads a `.gitignore`, `.ignore` or `.git/info/exclude` inside the walked directory that is a symbolic link, as git reads no symlinked `.gitignore`; git does follow a symlinked `.git/info/exclude`, so there the walk now differs from git
- Fixed the bash tool's built-in `rsync -K` (`--keep-dirlinks`) reporting `Operation not supported (95)` where rsync 3.5.1 reports `Too many levels of symbolic links (40)`: when the destination name of a directory is a symlink to a directory and the modes differ, rsync refuses to set the mode through the symlink with `ELOOP` (exit 23), and the built-in now refuses it the same way. A symlink's own mode is still set with lchmod where the platform can
- An empty word used as a file name (`cat < ""`, `exec 3< ""`, `echo x > ""`, `. ""`) now fails with `No such file or directory`, as bash and zsh do, instead of naming the working directory; `<& ""` and `>& ""` are a bad file descriptor, bash's `cd ""` is `null directory` and `history -r ""` is `empty filename`, as in bash 5.3; in zsh mode `exec ""`, `""` and a directory on `$PATH` are `permission denied` (126).
- A program a shell session has just written no longer fails at random with "Text file busy" when another session of the same process starts a program at that moment: the bash and zsh shells try such a program again after short waits (about 1 s in all) on the session's own timers, so its other commands, timers, timeout and cancel go on meanwhile. A background job's `$!` is known at once, as in bash: the job's own process waits for its program, and only a use of the job, such as `wait $!`, waits with it (a script without a `#!` line excepted: `$!` waits until it runs). A program that something keeps open for writing still fails with "Text file busy", after those waits rather than at once.
- A command substitution in an interactive shell's prompt (bash `PS1`/`PS2`, zsh `PS1`/`RPS1`/`PS2` with `promptsubst`) no longer sets `$?`: the next command and the shell's exit status see the last command's status, as in bash and zsh (`PS1='$(exit 3)> '; false`, then `echo $?` printed 3)
- A background command whose redirection open waits no longer takes a descriptor its own redirections close or replace before anything reads it (`4<&-`, `4< file`, `4>&1`): when that descriptor was a process substitution, the shell's own `read` of it found nothing until the command ended, where bash reads the line at once.
- A background command whose redirection open waits (a FIFO with no other end yet) no longer holds the shell's other pipes while it waits: the child the bash and zsh shells fork for it closes the descriptors its exec would close (the shell's own, all close-on-exec) before its redirections, so another job's reader gets end of file when its writer ends, as in bash.
- A background command whose redirection open waits for a FIFO's other end, and whose later redirection is bad (a dup of a closed fd such as `3<&9` or `3< /dev/fd/9`, or a target that expands to two words), no longer leaves the FIFO's reader waiting for ever: the child opens the FIFO and then fails that redirection, as bash's child does. The shell refused it before the child existed, so the FIFO was never opened.
- `$(< file)` reads the file in the shell itself, as bash and zsh do, instead of in a subshell. The file name may hold a substitution (`$(< "$(cmd)")` was empty), and `$(0< file)` is read too (it was empty). `set -u` ends the shell on an unset name in it. No DEBUG trap, `BASH_COMMAND`, trace line or `PIPESTATUS` change is made for the `< file`. A directory reads as empty with status 0 in bash, and as zsh's `error when reading NAME: is a directory`. In zsh, a successful read leaves `$?` alone, and the name is not globbed.
- bash: a `break` or `continue` inside `${| …; }` or `${ …; }` ends the substitution's body and waits, as bash 5.3's does: the command holding it still runs (with the substitution empty, and any later substitution of that command empty too), then the loop ends or goes on. A function, `eval` or trap the command reaches runs none of its commands meanwhile, and a `return` carries the wait to the caller's loops. With no loop, the message is printed and the command runs; before, the command was dropped. A `break N` or `continue N` with more levels than the loops inside an `eval` or `${ }` goes on to the loops around it. One in the redirections of a program (an external, a pi utility, a name not found), such as a here-document of `cat`, leaves no loop: bash expands those redirections in the forked child, so the `break` ends with it.
- bash: a `break` or `continue` in `${| …; }` or `${ …; }` in a `( … )`'s own redirection prints the `only meaningful in a loop` message and the rest of the substitution runs, as bash expands those redirections in the subshell, which has no loop (a `$( )` or `<( )` there has none either); before, it ended the loop around the `( … )`. One in a loop's own redirection is taken by that loop, which bash counts only as it starts: the loop runs no pass for it (a `for` binds its first word and a `select` reads its first line first, an arithmetic `for` evaluates its first two expressions, and a `while`'s skipped test has the status `$?` has, which a `continue` goes by), a count is capped at the loops around it, and the levels left go on out; before, the loop around it took the break. A `break` in a `for`'s own words also waits for its first word, and a substitution in a `for`'s or `select`'s words runs nothing while the break waits and gives nothing, as in bash; before, the loop around it took the break. A trap that a command in `${| …; }` or `${ …; }` sets off, in a command's words or a compound command's own redirection, runs before the next command there, as bash runs a pending trap as each command ends; it ran after the whole command, and was lost when a `break` waited. In a program's or a `( … )`'s own redirection it waits for that command, as bash expands those in the child. In a builtin's or a function's redirection it still waits too, where bash runs it at once.
- bash: an error in an arithmetic `for`'s header (`for (( j=; j<2; j++ ))`, a division by 0) ends that loop with status 1 and the commands after it run, as in bash; its message goes where the loop's own redirections send it. Before, the whole command was dropped. An error in the first expression ends the loop before it starts; an error in the test also takes one level of a `break` or `continue` that waits for the loop. No ERR trap runs for it, and `set -e` does not exit.
- bash: `ambiguous redirect` names the word as bash stores it: each command substitution as the parser re-prints it (`$(  true;false  )` is named `$(true; false)`, `${| return 3; }` is named `${|return 3; }`), `$'…'` decoded in single quotes, and `$"…"` as `"…"`.
- `$BASHPID` is `$$` in the shell itself (at the top level, in a function, `eval`, a group and a `lastpipe` stage), as in bash; it was a virtual pid no process has
- A shell refuses an engine whose first virtual pid is below the system's pid limit (Linux `pid_max`, macOS 100 000): a virtual pid there would name a real process to `kill`, `wait` and the user's tools
- A shell that has handed out its last virtual pid (2 147 483 647) no longer hands out numbers past it or wraps around to numbers an OS process can have: a command that needs one fails as when bash cannot fork (`fork: Resource temporarily unavailable`, status 254; zsh: `fork failed: …`, status 1; `zpty`: `can't create pty command`, status 1). A script then ends as it does after `exit 254` (zsh: with status 1), a failure inside a subshell ends only that subshell, and an interactive shell drops the command and reads the next one. A prompt whose command substitution needs a virtual pid then fails as an expansion: the message once, the prompt empty, and the line is read, as zsh does (bash retries the prompt every 15 s and reads nothing). An engine whose first virtual pid is the last one or above it, which leaves none for a child, is refused
- A bash command substitution that has no command (`$()`, `$( )`, only comments) runs nothing and leaves `$?` as it was, as in bash: `false; echo "$( )" $?` printed `0`
- A cancelled or timed-out `Shell.run` no longer ends the `&` jobs earlier runs left running, and the shell keeps its session (variables, working directory, jobs) for the next run; only what the cancelled run started is stopped
- `kill $!` of a `( list ) &` job reaches the subshell that runs the list, as in bash, which runs such a job as one process. Only the job's own vproc died: `wait $!` answered at once with its status, the subshell's trap of the signal never ran, and without `end_orphan_jobs` (obash, the engine's default) `( while :; do :; done ) & sleep 1; kill $!` left the loop running for the life of the shell. Now the subshell's trap runs, `kill -STOP $!` and `kill -CONT $!` stop and continue it, and `wait $!` returns the subshell's status. The same holds for a job with redirections (`( list ) >file &`, `( list ) 2>&1 &`) and for a `( … )` that is a subshell's whole body (`( ( list ) ) &`), which bash also runs as one process, but not for a `( … )` after another command (`( :; ( list ) ) &`, `true && ( list ) &`), for which bash forks a second process that the signal does not reach. `kill %1` already reached the subshell; for a job with redirections, `wait` after it now returns the status the subshell's trap exits with, not 143.

### Fixed

- The bash tool's built-in `rsync --timeout=N` no longer skips a keepalive while it waits on a quiet peer on a busy machine. The check after a keepalive was timed from the check that queued it, not from when the keepalive was written, so a keepalive written late left the next check short of half the timeout: that check sent none, the peer heard nothing for about the whole timeout, and the check after it could end the transfer with `[sender] io timeout after N seconds -- exiting` (exit 30). The next check now comes a whole check interval after the keepalive is written, as rsync 3.5.1's does.
- A subshell, command substitution, background job or pipeline stage that a fatal expansion error ends (`( : ${x:?u} ); echo "st=$?"`) no longer leaves the shell waiting for it for ever when the shell cannot reopen its standard error: on Linux a terminal, a socket or a pipe another user made, on macOS any pipe, socket or terminal. It ends once its message is out, with bash's status.
- A fatal expansion error (`${x:?}`, `set -u`, `$((1/0))`) in the redirections of a command bash runs in a process of its own (an external, a name not found, `command X`, a null command that redirects standard input or a `{var}`, a `( … )`) now fails only that command, with bash's status (127 under `-c`, 1 from a script or after an arithmetic error; a null command 1 under `-c` too, as bash 5.3 does), and the shell goes on; it ended the shell. Such a command leaves no `{var}` descriptor or value in the shell, whether its redirections fail or it runs (the command itself still gets them), and its name is still looked up and hashed, as bash does before it forks.
- An asynchronous simple command's or a pipeline stage's fatal error in its words, its redirections or a function it calls, and one in an asynchronous compound command's or a compound stage's own redirections (`{ cmd; } < ${x:?} &`), now exits 127 under `-c`, as bash's does (a fatal error in a `{ }` stage's body still exits 1), also after a `!` (`! /bin/cat < ${x:?} &`); a fatal error in those redirections prints its message where they so far sent it (`2>/dev/null` hides it), as bash's does. A builtin the job or stage runs exits 1 on a fatal error it meets (`eval 'echo ${x:?}' &`), as in bash. An asynchronous null command, or a pipeline stage, that redirects standard input or a `{var}` now exits 0 whatever its redirections do (`< missing &`), as bash's does; it exited 1. Under `set -e` the shell's own fatal error under `-c` (`set -e; echo < ${x:?}`) now exits 1, as bash's does; it exited 127.
- A redirection that duplicates a descriptor that is not open now names it as bash does (`<&07` names `7`, `3<&$fd` names `3`, `<&$fd-` names `0`), and a move the shell undoes, or a `{var}` copy, first prints bash's `redirection error: cannot duplicate fd: Bad file descriptor`.
- A timed background compound command whose own redirections meet a fatal expansion error (`time { :; } 2>/dev/null < ${x:?} &`) prints its message where those redirections so far sent it (`2>/dev/null` hides it), as bash's does: bash makes them in the job's process before it times the command. It printed the message on the job's original standard error.
- Fixed the embedded shell's interactive line editor running an accepted line before the line was on the terminal: the line's last display could still be in the terminal's writer thread when the command started, so an external command's output came above the line it ran from (`cat ~/log` printed its lines, then `cat ~/log`). The editor now hands on a line it read (and `vared` assigns, and a `zle` call in a widget returns) only once its display is out, as zsh's blocking writes order them; a trap that runs while the editor waits for its display to go out (a signal, or `TMOUT` with `TRAPALRM`) waits for it too, and the command after a job notice (`zsh: killed`) waits for the notice
- Under gVisor before google/gvisor@d6786915, a shell redirection that opens a FIFO for reading (`mapfile -t l < f`, `cat < f`) no longer waits for ever when its writer opened, wrote and closed while the open waited (`{ echo a; } > f & mapfile -t l < f`): once the open has waited 50 ms (then up to 1 s between looks) it looks for bytes in the FIFO through a read end it keeps open until the open is over, and takes them. Only under gVisor (the kernel release uname gives ends in `-gvisor`) is an open looked at; elsewhere nothing changes. One thread for the process makes the looks of every open; no open starts a thread for them. Under gVisor the look takes whatever bytes it finds, so it has these limits: a FIFO that holds bytes another reader left, with no writer, gives them to the open after 50 ms, where Linux waits for a writer; so do bytes gVisor keeps after every end of the FIFO closed (written through an end opened for reading and writing, or left unread by a reader that closed), which Linux frees; a writer that closes without writing can still leave the reader waiting; and once the look took an open, its write opens (up to 100, 10 ms apart) end with end of file the wait of another reader of that FIFO in its open at that moment. The helper thread of such an open that gVisor keeps asleep is left behind (a 64 KiB stack and the open's `O_PATH` descriptor, no end of the FIFO); once 64 are left, read opens are no longer looked at, so no more are left.
- Fixed the embedded shell losing up to 64 KiB written through a zsh multios redirection (`{ ... } >&1 >/dev/null`, `exec >&1 >/dev/null`) by `syswrite`, `sysread -o` or a builtin whose output went out at once: the tee only queued the bytes, the writer counted them as written, and the queue was dropped when the redirection or the run ended. Each write through the tee now ends once every target of the tee has it
- Once the last program of a background pipeline is gone (`kill -0 $!` fails) and its other programs have ended, `jobs` (also `-r`, `-n`, `%1`), `$(jobs)`, `fg`, `bg`, `disown -r` and `kill %1` see the job done, as bash does: `jobs` no longer lists it `Running`, `fg`/`bg` say `job has terminated` instead of waiting for it or calling it already in the background. The builtins that report or decide by a job's state, zsh's too, first take in the exits already available, so the end of a pipeline's stage reaches its job before such a builtin reads it. `kill %1` of a finished job no longer says `no such job`: as bash 5.3 does, it succeeds and signals nothing without job control, and reports `(pid) - No such process` with it.
- The `!` of a background job (`! cmd &`, `! a | b &`) no longer inverts the job's status, as in bash and zsh: `wait $!` returns the command's own status, and `set -e` acts on it. A `!` inside the job, or before an `&&`/`||` list, inverts as before; zsh mode still inverts a timed job's `!`, as zsh does. `jobs` shows such a job of simple commands without its `!` (`false &`), as bash does.
- `wait PID` of a background job that `jobs` reported and forgot returns its status, as bash's list of saved statuses does, where it said `not a child of this shell`; a second `wait PID` of a job returns its status again. A plain `wait` and `disown -a` forget those statuses, and a posix-mode `wait PID` forgets the one it returned, also while the job's pid is still `$!`. A job `disown` dropped is no longer waited for: `wait` returns at once, and `wait $!` answers at once (0 after `disown` or `disown %1`, `not a child` after `disown -a` or `-r`); its end still runs a `CHLD` trap, as bash counts every child it reaps. `kill %1` makes the job's state news again for `jobs -n`, and `kill PID` first takes in the exits already available, as `kill %1` does. Taking in exits runs no process out of its turn: the shell's own commands keep running beside background loops that start subshells.
- A snapshot taken while `jobs`, `kill` or `wait` waited for the exits already available to be taken in no longer loses that wait: the shell restored from it answers the builtin as the shell without the snapshot does. `kill` of a running in-engine job (`{ while :; do :; done; } & kill -KILL $!`) never sent when a snapshot came between its ask and the answer, and the shell ran on for ever.
- A trap no longer runs inside a builtin that waits for the exits already available to be taken in (`jobs`, `kill`, `fg`, `bg`, `disown`, zsh's `jobs` and `kill`). It ran with that builtin's redirections, so in `trap 'echo chld >&2' CHLD; /bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done` the trap's error output went to `/dev/null`, and with `jobs` the trap's output came before the job it listed. The trap now runs once the builtin's command is over, before the next command, as bash runs a trap between commands.
- `$!` of a background job is there at once, as in bash and zsh, when the job runs a builtin whose output waits for the shell (`printf … &`, also as a function's command or a pipeline's last stage), a loop that never ends, a command substitution or a `set -T` DEBUG trap action that waits for the shell, `eval`, `.` or `source` again without end, or (zsh) a redirection whose FIFO open waits: reading `$!`, or `kill`, `wait` or `jobs -p` of it, no longer waits for the job to end. A job that `exec`s its program after builtins, loops, command substitutions or subshells that waited for nothing (`f() { cd /; exec prog; }; f &`) has the program's pid in `$!`, as in bash. A job that runs another program before its `exec`, or reads a pipe, or (read while it waits) runs past a scheduler slice or opens a FIFO in zsh, keeps its own pid, which the `kill` and `wait` builtins accept but `ps`, `/bin/kill` and `/proc` cannot find.
- The DEBUG trap of a background simple command (also a negated one, `! cmd &`), and of each simple stage of a pipeline, runs in the shell before it forks, as in bash, with or without `set -T`: it ran in the job with `set -T` (a variable it set never reached the shell, and `$!` could wait for it) and not at all without. A `time`d background pipeline forks first and runs its stages' traps itself under `set -T`, as in bash. `extdebug` now skips such a lone job before it forks (status 1 for `! cmd &`), and in a pipeline only the stage whose trap failed, with no process for it; a background pipeline whose stages are all skipped starts no job, as in bash. A command or process substitution a DEBUG trap action starts (bash's and zsh's), and the command `nohup`, `timeout`, `xargs` or `find -exec` runs, run no DEBUG trap: `set -T` with `trap 'x=$(echo y)' DEBUG`, `trap 'cat <(echo y)' DEBUG` or `trap 'nohup cmd' DEBUG` no longer recurses without end. zsh: a trap function (any `TRAPNAL`, such as `TRAPDEBUG` or `TRAPZERR`) whose last command fails, or that `ERR_RETURN` returns from, no longer ends the code it interrupted; only an explicit `return N` does, as in zsh.
- The shell runs the DEBUG trap of a pipeline stage or a background simple command whose words or redirections hold a command substitution too (`echo $(echo a) | cat`, `cat 2> $(f) …`, `cmd $(f) &`), as bash does, with the command's own text, and `extdebug` skips it: such a stage got no trap without `set -T`, and ran it itself, after the shell's later stages, with it. `$!` of such a job (`cmd "$(f)" &`, `{ exec cmd "$(f)"; } &`) is its program's pid, as in bash, where it named another process
- Fixed `history -w` and `history -a` to a FIFO, a pipe or a socket writing the history again on every poll, without end; the write now counts the bytes it wrote instead of reading the file's position, which such a file does not have
- Fixed omp freezing for seconds to minutes on WSL2 while saving sessions: Linux `FileLock` now locks a sidecar file instead of binding a socket, which takes about 10 ms per call there. Older omp versions still running do not see these locks, so restart them after updating ([#19704](https://github.com/can1357/oh-my-pi/pull/19704) by [@turgaybulut](https://github.com/turgaybulut))
- `EditSession.apply` takes the tool call's abort signal (`signal` in its request). Before, a cancelled edit could still write its files after the abort was reported. Once the signal fires, `apply` stops waiting on URL resolution or missing-path recovery and hands no further write to the host writer; a call stopped that way ends as an error of kind `cancelled` whose message names what the call's earlier writes changed (a move by its source and destination, a delete as deleted). `apply` does not interrupt a write the host has already begun, and the call ends as that write's result: if the host fails it, `write_failed` with the host's error, naming no earlier file; if it succeeds, it is named by the cancel at the next write, or, as the call's last write, the call succeeds. A write handed to the host just before the abort can still reach the writer after it: a writer that must start nothing after the abort checks its own signal and returns `cancelled: true`.
- Fixed embedded-shell `xargs` and `find -exec ... {} +` failing with "Argument list too long" where the system takes fewer argument bytes than they counted on (GKE Sandbox, whose gVisor can say `ENAMETOOLONG` instead, or `ENOMEM` when the line's strings end exactly on its 2 MiB limit; or, for `find`, exported shell variables its count leaves out): like GNU xargs, they split a refused command line in halves and retry, and one argument too long on its own is still an error (`xargs` status 1, with GNU's `can't call exec() due to argument size restrictions`; `find` status 1)
- Fixed the embedded shell losing a command's last output on a loaded machine (`status 0`, no output): once a command ended, the run cancelled its output reader after 250 ms of quiet and dropped what the pipe still held. A cancelled reader now reads what the pipe holds before it stops (on Windows, once it has ended its read in flight), and the run waits for it. A command that ended before the run's timeout keeps its exit status while its output is still being taken; past the timeout, a consumer that takes nothing for 2 s (5 s on Windows) ends that wait, the output it did not take is dropped, and the result says so (`ShellRunResult.outputDropped: true`)
- Fixed `execute_shell_streams` holding a runtime thread while a bounded sink was full: its readers now wait for the consumer as the text readers do
- Fixed the embedded shell keeping a pipe or FIFO open for a moment after it closed it, while its readiness thread still waited on the descriptor (`poll(2)` holds a file open until it returns): a writer that opened the FIFO next could pair with the reader the shell had closed, so what it wrote was lost and the next reader waited for a writer for ever (`{ printf c; sleep 0.2; } > f & read -t 5 x < f` right after another read of `f`). Dropping a descriptor's readiness wait now ends the thread's wait first
- Fixed the embedded shell's `cmd > fifo &` with a reader of the FIFO under gVisor (GKE Sandbox) before google/gvisor@d6786915: the shell first tried a non-blocking open for writing, and gVisor counted that failed open (`ENXIO`, no reader yet) as a writer for a moment, so a reader opening the FIFO then returned with no writer and read end of file while the real writer waited for a reader for ever. A FIFO opened one way that exists when the open starts now goes to the helper thread at once, before any non-blocking open
- Fixed the embedded shell's process substitution and large here-documents failing with "File exists" when an earlier process with the same pid left its temp node behind (one killed before its cleanup; pids come round again within minutes on a busy machine): a name already taken moves on to the next
- Fixed `Process.killTree`, `terminate` and `children` failing with `cannot list the threads of process N: No such file or directory` under gVisor (GKE Sandbox) for a multi-threaded process caught while it exits: gVisor takes `/proc/<pid>/task` away as the process's leader thread exits, while the process runs on until its last thread does. When `/proc` still shows the process by its start time, the walk now finds its children by their parent pid instead; a thread list it cannot read for any other reason still fails the call. The walk also finds the children by their parent pid when a thread exits between the thread list and the read of its children, where it used to miss the children the kernel gave to another thread
- Fixed the embedded shell's `cp -r`, and `mv` of a directory to another file system, on a tree deeper than the open-file limit or than the thread's stack allows. The copy kept each level's directory listing open while it copied the level below, so it failed with "Too many open files" (300 levels under a limit of 32). It also recursed once per level, so a deep tree overflowed the thread's stack and ended the whole process (1,500 levels on a 256 KiB stack). Like GNU cp, it now reads each directory whole before it goes below, and keeps its place on a stack of its own: at 10 or 2,000 levels it holds at most two descriptors at a time, and the moved source is removed with at most three
- The bash tool's built-in `rsync` now escapes non-ASCII bytes in the file names it prints when the shell's locale is C/POSIX, the way rsync 3.5.1 does; a UTF-8 locale and `--8-bit-output` print them unescaped ([#17401](https://github.com/can1357/oh-my-pi/pull/17401) by [@sjawhar](https://github.com/sjawhar))
- The bash tool's built-in `df`, `du`, `env`, `fold` and `sort` now read a locale the shell exports in a Docker container with the default security profile, where they reported that the system `locale` utility could not be started
- The native addon now loads from a directory whose path contains `?`, such as a `HOME`, `PI_NATIVES_DIR` or install directory named that way; the loader opens each `.node` with `process.dlopen`, because Bun's `require` cannot load a module from such a path
- Fixed a parallel directory walk (`grep()`, `glob()`, `fd()`, ast-grep, edit path recovery, and the shell's `grep -r` and `rg`) that could hang for ever, about once in several thousand walks on a busy machine with 8 or more CPUs: a worker that missed the wakeup for its stop message waited for ever, with the message still queued. A walk now stops by closing its job queue
- Fixed a walk that its caller dropped before its first worker ran reading freed memory as a path
- Fixed a panic in the input of an ordered search pool being swallowed, which ended the search early with no error; it now reaches the caller after the outputs before it
- Fixed the darwin native addons failing to build on a Linux build host: the macOS SDK now comes from the Command Line Tools for Xcode 27.2 package (`MacOSX27.2.sdk`) (by [@sjawhar](https://github.com/sjawhar))
- Fixed the darwin native addons failing to build on a machine without a warm Bazel repository cache: Apple superseded the pinned Command Line Tools SDK on 2026-10-29 and its download now returns 403, so the macOS SDK is taken from the Xcode 27.2 package (`MacOSX27.2.sdk`) ([#TBD](https://github.com/can1357/oh-my-pi/pull/TBD) by [@sjawhar](https://github.com/sjawhar))
- The native loader honours `OMP_DOWNLOAD_ROOT` and `OMP_CONFIG_ROOT` when it resolves its natives directory
- Native git reads the global and system configuration as git does: `GIT_CONFIG_GLOBAL` replaces `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` (empty means none) and `GIT_CONFIG_NOSYSTEM` skips the system file, so an identity, signing or hooks in a home it was told not to read no longer reach its commits; a `GIT_CONFIG_NOSYSTEM` that is not a boolean is refused with git's message, as git refuses it, instead of reading the system file
- Native jj reads `JJ_CONFIG` as jj does: a list of TOML files and directories separated by the platform's path separator, and a set but empty value reads no user configuration. A user config that names watchman no longer makes every native jj snapshot fail; it scans without the monitor
- The addon loader now resolves the natives directory with the same `getNativesDir()` that pi-utils uses (new export `@oh-my-pi/pi-natives/natives-dir`): `PI_NATIVES_DIR`, then `OMP_DOWNLOAD_ROOT`, then `$XDG_CACHE_HOME/omp` on Linux and macOS, then the config root, honouring `PI_CONFIG_DIR`. A grammar omp downloads under XDG, a named profile or `PI_CONFIG_DIR` is now found, where before it was downloaded once and never loaded, and `ast_grep`/`ast_edit` skipped that language saying the grammar could not be downloaded; the addon moves from `$XDG_DATA_HOME/omp/natives` to `$XDG_CACHE_HOME/omp/natives`. The directory is one answer per process, fixed before omp applies `.env` files, so a directory variable a `.env` file sets no longer makes the loader, pi-utils and omp's subprocess workers name different directories, nor a compiled binary load a second copy of the addon. omp's own children that are omp take its answer from a private handoff; the commands the agent runs get `PI_NATIVES_DIR` as omp was started with it. [The natives directory](../../docs/natives-addon-loader-runtime.md#the-natives-directory) has the full rule
- A compiled binary no longer loads a native addon another build of the same release extracted. It reused any cached `<natives dir>/<version>/<addon>` of the expected size, and every build of a release shares its version, so a build could run another build's native code. The embedded manifest now carries each addon's SHA-256 and a digest of the set, computed when the binary is built; each build extracts into `<natives dir>/<version>-<digest prefix>` and checks the SHA-256 of what it writes. Two builds run in turn keep one copy each instead of extracting one at every switch. Cleanup now removes every addon cache directory no omp process has used for a day, whatever its version, instead of older releases ten minutes after their last use, so an older release run in turn with a newer one also keeps its copy. Cleanup no longer removes a directory a start marked used while cleanup was checking it: it renames the directory away, checks its time again, and renames it back; a start whose addon was not there when it loaded it, though the check before found it, loads it once more (from the directory cleanup put back, or after extracting it again) instead of failing. The temporary file an extraction writes is named with a random UUID, so worker threads of one process no longer share one
- A Windows npm install no longer loads a staged native addon another install of the same release left. It reused any `<natives dir>/<version>/<addon>` that existed, whatever its bytes. Each leaf package (`@oh-my-pi/pi-natives-<platform>-<arch>`) now records its addons in its `package.json` (`nativeAddons`: each one's size and SHA-256 and the set's digest, computed when the package is generated), and the loader stages them into `<natives dir>/<version>-<digest prefix>`, checks each copy's SHA-256, and replaces a copy of the wrong size. A leaf that records no addons, or records them in another shape, is loaded where it is installed
- An extracted or staged native addon is synced to disk before it is renamed into place, and its directory after, so a crash cannot leave a file of the right size whose bytes never reached the disk
- A workspace checkout now notices an addon of its release built from Rust sources other than its own. The native build (`scripts/bazel-natives.ts`, `build-bindings.ts`) records the source files it compiled in `<addon>.sources.json`: under its roots (for a Bazel build, Bazel's own inputs as well: the root `BUILD.bazel`, `MODULE.bazel`, `.bazelrc`, `.bazelversion`, `.bazelignore` and `bazel/`), the files git tracks or would track (in a repository whose top level is the tree; elsewhere, or when git refuses it, listed against a throwaway repository so `.gitignore` still applies), symbolic links as links, never followed, and a FIFO, socket or device by its kind alone, never opened; in each directory a build script scans, the files its `glob()` matches, gitignored or not, and which packages have a `build.rs`; `Cargo.lock` as the build left it when Cargo rewrote it; the checkout that built it, by a random id the first build keeps in its git directory (`omp-checkout-id`, linked into place whole, so builds that start at once agree on it; found through a `.git` that is a link, through a link to a `.git` file, and through a link to a submodule, as git finds the git directory), which a moved or bind-mounted checkout keeps and a new checkout made at the same path lacks; the addon by its size and a whole-second modification time, which Docker layer copies keep; and its profile, features and flags for diagnosis only. Both builders check the sources again before they install anything, so a check that throws leaves the old addon and its record in place. A listed file other than `Cargo.lock` that moved while the build ran, even one put back as it was (an editor's undo, `git stash` and `stash pop`, `touch -r`), or a scanned directory that did (a file added there and removed again), gives a record that reads as other sources until the next build, since the compiler may have read the edit. Every file the build and a load read for this (the sources, each `BUILD.bazel`, the checkout id, the record) goes through one reader that opens only a regular file, without following a link or waiting, and names anything else by its kind, so neither a build nor a start blocks on a FIFO or throws on a file swapped for a link or a socket. A listed regular file that cannot be opened (no permission, no descriptor left), or a listed link whose target cannot be read, stops a build with that error, and a start reads it as no verdict (`unknown`), never as other sources. A workspace load compares the listed files with the checkout, by their sizes, modification and change times and inodes at each start (and each scanned directory's) and by content only when they changed or the judging checkout differs, so an edit whose size and modification time were put back (`touch -r`, a rename over the file) is seen, as git's own stat check sees it. It keeps a verdict only for what its own read of the bytes found, and only when the files still match that after the read, so a file swapped or edited during a start, even one put back as it was, is read again at the next. A build and a start keep a file state or a scanned directory's state only when each time in it is more than two seconds older than their read (git's racy-clean rule), so a same-size edit, or a matching file added to a scanned directory, in the same timestamp tick as that read is seen at the next start on a kernel whose timestamps are coarse (Linux before 6.13); a file or directory changed less than two seconds before a start is read or listed again at the next. A file a build script's glob matches added to its directory, gitignored or not, or a new `build.rs`, reads as other sources, while any other file added after the build (an editor backup, a README, a new test) changes nothing. A file git did not track at build time must keep its bytes, and in the checkout that built the addon must not move or go away; only another checkout may lack it. An addon built from other sources gets the stale-addon notice and the missing-export stubs instead of loading as current. robomp's natives cache carries the record with its addon, and its key now covers `.cargo/`; the Docker build contexts leave out a host's record. Compiled binaries and package installs never read the record
- Fixed a `git status` that exceeded its deadline leaving a stale `.git/index.lock` behind, which made every later git or jj write in that worktree fail until the lock was deleted by hand ([#13405](https://github.com/can1357/oh-my-pi/pull/13405) by [@sjawhar](https://github.com/sjawhar)).
- The bash tool's built-in `df`, `du`, `env`, `fold` and `sort` now honour a locale the shell exports through `LOCPATH` instead of falling back to the C locale, so a German locale there gives `sort -n` and `du -h` a decimal comma and a UTF-8 one stops `fold` splitting characters; whether a locale is UTF-8 now comes from its data rather than its name. `sort`, `du` and `df` were compared with GNU coreutils 9.4 runs; `fold` and `env` model coreutils 9.12, newer than the 9.4 available, so their reference is libc's own answer (`locale charmap`) ([#17401](https://github.com/can1357/oh-my-pi/pull/17401) by [@sjawhar](https://github.com/sjawhar))
- The bash tool's built-in `df`, `du`, `env`, `fold` and `sort` now run in the C locale when one category the shell's locale names is not installed, as GNU coreutils do when `setlocale(LC_ALL, "")` fails, instead of applying the categories that do load: `sort` compares bytes and `sort --debug` reports `failed to set locale`, `du` and `df` group no digits, and `fold` splits multibyte characters; each prints a warning when it cannot read the shell's locale at all. `sort`, `du` and `df` were compared with GNU coreutils 9.4 runs; `fold` and `env` model coreutils 9.12, newer than the 9.4 available, so their reference is libc's own answer (`setlocale` failing, as bash reports it) ([#17401](https://github.com/can1357/oh-my-pi/pull/17401) by [@sjawhar](https://github.com/sjawhar))
- Fixed `TtyWriter.flushSync()` and `stop()` sometimes waiting out their whole timeout after the queued output had already been written ([#13794](https://github.com/can1357/oh-my-pi/pull/13794) by [@sjawhar](https://github.com/sjawhar)).
- Fixed `TtyWriter.stop()` occasionally hanging forever when the queue had already drained ([#13794](https://github.com/can1357/oh-my-pi/pull/13794) by [@sjawhar](https://github.com/sjawhar)).
- A walk of a host directory that does not follow symlinks (`grep()`, `grep -r`, `rg`, `find -delete` without `-L`, `ast-grep` and `astGrep`/`astEdit` without following links) no longer reads, rewrites or deletes a file through a symlink swapped in after the walk listed it: the file is reached below the walk's own open root, and a swapped directory makes that file's read, write or removal fail instead of reaching outside the tree
- `find -delete` reports a failed removal as GNU find does (`find: cannot delete 'path': reason`, exit status 1), and `find . -delete` keeps `.` without an error
- Fixed `omp worktree clear` deleting the registration of a locked worktree whose checkout it could not see, such as one on a disk mounted only on another machine; like `git worktree prune`, it now keeps locked registrations, and treats a dangling link where a checkout's `.git` or the `locked` file was as something there
- On a shell running on a single-threaded runtime (the Windows fallback when no worker thread can start), a pipe or `$(…)` on a builtin's input or output no longer ends `grep`, `rg` (also with `--line-buffered`) or `find -help`/`-version` with `internal error`, loses every utility's `--help`, `--version` and usage errors, or breaks `ps`/`pgrep`/`pkill`/`pidwait -t` given a descriptor or virtual path
- Under gVisor releases before 20261109.0 (GKE Sandbox among them), which follow a symlink to a directory despite `O_NOFOLLOW` when `O_DIRECTORY` is set, such a walk and `readFileBeneath()` no longer enter a directory swapped for a symlink, or a symlink on the way to the file: unless the kernel was seen refusing such a link (probed once per process on `/proc/self`), each directory the walk opens is opened with `O_NOFOLLOW` and without `O_DIRECTORY`, which gVisor honours, and refused unless `fstat` shows a directory
- Under those gVisor releases, the bash tool's `rm -r` no longer deletes files outside the tree it removes through a directory swapped for a symlink while it runs: it enters, and lists for `-i`, only the directory it found at the name, by device and inode, and reports any other as `Not a directory`
- `find` without `-L` or `-H` no longer walks, or deletes below, a symlink put in place of its starting point after find checked it, on any kernel: the starting point opens without following a symlink there, unless it ends in a slash (`find root/`), which follows a symlink in the check and the open alike, as GNU `find -P root/` does
- The bash tool's `rm -r` no longer empties the target of a symlink put in place of its operand after rm checked it, on any kernel: the operand opens without following a symlink, as the directory `lstat` found, and any other is reported as `Not a directory`
- Under gVisor releases before 20261109.0, `mv` of a directory across filesystems no longer deletes files outside the moved tree through a directory swapped for a symlink: it removes the copied source, and a directory it replaces, with `rm -r`'s walk
- The bash tool's `mv` of a directory into a directory that holds a regular file or a symlink of the same name is refused as GNU mv refuses it (`cannot overwrite non-directory`, exit status 1): across filesystems it deleted that file or link and copied the directory in its place
- The bash tool's `mv` takes a symlink at the destination's name as a destination, also one that points nowhere, as GNU mv does: `--backup` moves the link aside and moves, `-n` and `--update=none` keep it, `-i` asks about it, and `-u` compares the link's own time, where each acted as if nothing were there; with two operands, `mv -b dir file` backs the file or link up and moves, where it was refused. `-u` compares the source's own time too, and only for a source that is not a directory, as GNU does: a directory moved onto a newer non-directory is refused, and one moved onto a newer directory is no longer skipped, so it replaces an empty one and fails, with status 1, on one that is not empty. A source that is the destination's simple backup (`mv -b dest~ dest`, `cp -b dest~ dest`, or `./dest~`) is refused by `mv` and `cp` in every backup mode but `numbered` (`backing up 'dest' might destroy source`), as GNU refuses it, also where the filesystem reports no file identities: under `existing`, the default of `-b`, `mv` renamed the backup over the source and the source's contents were lost when `dest` was a symlink that points nowhere, and `cp` copied when a numbered backup was there
- The bash tool's `mv`, `cp` and `ln` with `--backup=numbered` or `--backup=existing` number a backup one past the highest `name.~N~` in the directory, as GNU does, whatever that entry is: a symlink that points nowhere at `name.~1~` was taken as free and replaced by the backup, a gap (`name.~1~` and `name.~3~`) gave `name.~2~` where GNU gives `name.~4~`, and `existing` numbered only when `name.~1~` existed. A numbered name longer than GNU's limit for the directory (one byte under its `NAME_MAX`) gives way to the name with `~`, cut to fit, as GNU's does; when an entry already holds that `~` name, `mv` and `cp` refuse the backup (`cannot backup 'D': File exists`, status 1), as GNU's do, where they replaced it, losing the source's contents when the entry was the source (`mv --backup=numbered D~ D`) and the old contents when it was the destination itself (`E` ending in `~`, whose `~` name is `E`); `ln` replaces such an entry, as GNU ln does. A backup whose name is the destination itself is refused in every mode by all three (`cannot backup 'E': File exists`). A backup whose entry is the source's own is refused by all three (`backing up 'D' might destroy source`), and so is one whose entry the source leads to where it is followed (`cp` without `-P`, `-d` or `-a`, and under `-R` only with `-L` or `-H`; `ln -L`): each symbolic link its last name leads to in turn, or the file it resolves to; a link in a directory part of its path is not checked, and GNU loses that link too. Entries are compared as gnulib's `same_nameat` compares them, by name and directory, except that the directories are read with `stat`, following a symbolic link to a directory as the rename does, where gnulib uses `lstat`; where names fold (a case-insensitive filesystem), a file with one link is one entry under both names (`DEST~` and `dest~`). With nothing at the backup name no entry is replaced, so `ln -s -b dest~ dest` with no `dest~` links and backs up, as GNU ln does. Another hard link of the source is another entry: the backup replaces it and the source stays, as in GNU, where `cp` refused it before these changes and the new checks of `mv` and `ln` refused it too. `cp` backs up a destination that is another link of the source's own file by renaming it, as GNU does, where it copied the destination through the backup name: that emptied all three links in `ln a dest; ln a dest~; cp -b a dest`, and wrote into the file a symbolic link `dest~` named. Where the backup name is another link of the destination's own file, GNU's rename does nothing and its create of the destination finds it there, and `cp` now does what GNU does, before anything changes: it fails where it creates a regular file, also under `-f`, `--remove-destination` and `--attributes-only` (`cannot create regular file 'dest': File exists`), or under `-R` a FIFO or device (`cannot create fifo`, `cannot create special file`), where it lost the old contents; a hard link (`-l`) fails without `-f` or `-i`, and a symbolic link (`-s`) and a copied link without `-f`, with GNU's messages (`cannot create hard link 'dest' to 'a'`, `cannot create symbolic link`), and with them replace the destination, the backup name keeping the old contents. A destination that is the source's own entry (`cp -fb a a`) is backed up as GNU backs it up, by a copy of the source in the current mode, after which there is nothing else to copy, and only where the two names are the same string, as in GNU, which compares them as strings and not as paths (`cp -fb a ./a`, `cp -fb <dir>/a a` and `cp -fb d//a d/a` are the same file, where `cp` made a backup; `cp -fb l ./l`, `l` a link, fails as GNU's does, `cannot open 'l' for reading`, after `-i` asks and `-u` compares, as GNU's do, where it failed first): `-l` makes the backup another link of the source's file, reading the backup name with `lstat` as GNU does (a link `a~ -> a` is replaced, where `cp` kept it), `-s` makes it a symbolic link to the source and keeps `a` (where `cp` made `a` a link to itself), refused for a relative source outside the current directory (`d/a~: can make relative symbolic links only in current directory`, where `cp` made a link that pointed nowhere) and compared by the backup name's own `lstat`, so a link `a~ -> a` is replaced, a link read as a link (`-P`) is copied as a link, a followed link copies the file it leads to (where `cp` lost the link `l` to the backup and failed), `--attributes-only` makes an empty backup or keeps the one there, and a data copy is written into a regular file at the backup name, keeping its mode and its other hard links and needing no write permission on the directory, creates the backup exclusively (`O_EXCL`) with the source's mode, removes and creates again (exclusively) a file it cannot open for writing, and refuses a dangling link at the backup name (`not writing through dangling symlink`) and one that leads to a directory; every mode refuses a directory at the backup name (GNU 9.7's message), `-p` gives the backup the source's attributes (a link copied as a link takes the link's own times, and one made by `-s` the source's, where `cp` gave both the current time), `-v` reports it (`'a' -> 'a~'`), and the errors are GNU's (`cannot create regular file 'a~'`, `cannot remove 'a~'`, `cannot create hard link 'a~' to 'a'`, `cannot create symbolic link`, and `cannot stat 'a~'` where a link's target cannot be read, where `cp` said the link pointed nowhere). GNU makes this backup by turning `cp -fb a a` into a copy of `a` to `a~`, and only where `stat` reads `a` as a regular file, so `-i` asks only about an `a~` that `stat` reads (`overwrite 'a~'?`; a link to nothing there is not asked about) and `-u` compares `a` with what `a~` leads to, and `cp` now does the same, where `cp -i -fb a a` said the same file and `cp -u -fb a a` compared `a` with itself and made nothing. It is refused as GNU refuses it where the backup name is the source's own file (`'a' and 'a~' are the same file`), and so is a FIFO, a device or a link to nothing read as a link that is its own destination, before `-i` asks or `-u` compares (`'p' and 'p' are the same file`), where `cp` read the FIFO and waited for a writer, and later asked about `p~` first and let `-u` skip it; another link of a FIFO is another entry and is backed up as any destination is. `-l` asks under `-i` about a destination that is already the source's file and then does nothing, as GNU does, a FIFO that is its own destination included, where it did nothing without asking. Without `-f`, `cp` makes no such backup, as GNU makes none: `-l` does nothing, `cp -b l l` cannot open the source (GNU renames it to the backup name and back), and the others are the same file. `--attributes-only` makes a backup, as GNU does, where `cp` made none. `cp` compares the source it opens with the one it read before the backup, as GNU does, before it clones or creates anything (`--reflink=always`, and every copy on macOS, cloned by path first and copied the old destination there), and fails where they differ (`skipping file 'x', as it was replaced while being copied`); a clone by path also reads the path again just before it, and where that no longer names the file opened, `always` fails as above and `auto` copies the file opened, as GNU, cloning from its descriptor, does. `cp -P -b x dest`, where `x` is a symbolic link to `dest~`, backs up over `dest~`, as GNU does, where `cp` refused it before these changes. Where these refusals differ from GNU 9.4 and 9.7, GNU loses data, and the difference is deliberate: `ln -b dest~ dest` and the numbered `~` case exit 0 with the source's contents lost (GNU ln renames the destination over its backup name with a plain `renameat` in `ln.c`, and checks no source), and so does `ln -s -b dest~ dest` where `dest~` holds a file; `mv -b dest~ dest`, where `dest~` is a symlink, exits 0 and loses the link; `cp -b x dest` and `ln -L -b x dest`, where `x` is a symlink to `dest~`, lose `dest~`'s contents (`cp` then fails, `ln` exits 0), and where `x -> dest~ -> a` GNU's `cp` loses the link `dest~` and then fails, and its `ln -L` loses it and links `dest` to the old contents; where names fold, GNU's `mv`, `cp` and `ln` lose `DEST~` in `-b DEST~ dest` (`cp` then fails); GNU's `cp -fb a a` with `a~` a symbolic link to another file writes through it, losing that file's contents (also after `-i` and `-u`), where here the link is replaced, so in a directory the user cannot write that backup fails here; and onto `E`, GNU's `mv -b` and `ln` exit 0 with the old contents lost, while GNU's `cp` keeps `E` but says `cannot create regular file 'E': File exists`. Where names fold and the source has another link, no name or identity tells the entries apart: the backup replaces the source's entry, as GNU's does, and its contents stay in the other link; `mv` and `ln` then move or link the old contents, as GNU's do, and `cp` fails as GNU's does, leaving the old contents at the backup name, where GNU renames them back. Where the directory cannot be listed, `existing` makes a simple backup, as GNU does, and `numbered` takes the first `name.~N~` no entry holds (GNU 9.4 and 9.7's `mv` and `cp` retry `name.~1~` without end there, which gnulib fe173e9544 changes to a failure, and its `ln` replaces it); after a listing that ends early with an error, the numbered name is confirmed free by `lstat`, though an entry made between that check and the rename is replaced, as after a complete listing. An empty suffix (`-S ''`, or an empty `SIMPLE_BACKUP_SUFFIX`) is `~`, as GNU takes it: `mv` and `cp` named the backup after the file and lost it, and `ln` failed with `File exists` and kept it; and `ln` reads `VERSION_CONTROL` and `SIMPLE_BACKUP_SUFFIX` from the shell, as `cp` and `mv` do, where it read the host process's environment
- The bash tool's `cp --remove-destination` no longer deletes a source that is its own destination: it decides whether the two are the same file, reading the destination with `lstat`, before it backs up or removes anything, as GNU does, where it removed the destination first and then could not open the source. `cp --remove-destination a ./a`, `a .`, `<dir>/a a`, `d//a d/a` and `d/./a d/a`, also with `-f`, `-s` or `-b`, are the same file and keep `a`, `-l` there does nothing, and a link `l` stays in `-P l ./l` (the same file) and `-b l ./l` (`cannot open 'l' for reading`). Another hard link of the source in another entry, or a symbolic link at the destination, is removed and replaced, as GNU does, and `cp --remove-destination -b a b`, `b` another link of `a`, backs `b` up to `b~` and copies, where it failed with `cannot backup 'b'`. GNU's `cp --remove-destination l ./l` and `l l`, `l` a link it follows, remove `l` and then cannot open it; here they fail with the same message, and `l` stays
- The bash tool's `cp -fb l l`, `l` a symbolic link it follows to a FIFO or another file that is not regular, asks under `-i`, and under `-u` compares that file's time with the link's own (skipping with status 0 where it is not newer), before it fails with `cannot open 'l' for reading`, as GNU's does, where it said `'l' and 'l' are the same file` before any question or comparison: GNU turns nothing into a copy there, and backs the link up by renaming it
- The bash tool's `cp -fb a a` turns into a copy of `a` to `a~` only in the two-operand form, as GNU's does: `cp -fb d/a d`, which copies `d/a` into the directory that holds it, also with `-t d`, an absolute directory, `--backup=numbered`, `-u` or `-i`, is `'d/a' and 'd/a' are the same file`, and `cp -l -fb d/a d` does nothing, where they made or overwrote `d/a~`, losing what an existing `d/a~` held
- The bash tool's `cp` keeps both `-f` and `--remove-destination`, given in either order, as GNU does, where the later one dropped the earlier: `cp --remove-destination -f a l`, `l` a link to `b`, replaces the link `l` with a copy and keeps `b`, where it wrote `a` into `b`; `--remove-destination` also removes the destination after `-i` asks, and `-f` with `-b` still turns `cp -fb a a` into a copy to `a~`
- The bash tool's `cp` reads a symbolic link at the destination without following it where GNU does (`-l`, `-s`, a backup, `--remove-destination`, or a source copied as a link or a special file): a link that points nowhere is then backed up, replaced or refused as any existing destination is (`cp -l a l`: `File exists`), where cp refused with `not writing through dangling symlink`, and `-u` compares the link's own time, so `cp -u --remove-destination a l`, `l` a link that points nowhere and is not older than `a`, keeps `l`, where it replaced it with a copy. `cp -l` and `cp -s` replace an existing destination as GNU's `force_linkat` and `force_symlinkat` do, under `-f` (and for `-l` under `-i`): the new link is made at a fresh name in the destination's directory and renamed over it, so nothing is removed before it is in place, and `cp -l -f l l` and `cp -l -f l ./l`, `l` a link to `a`, leave `l` another link of `a`, where they removed `l` and then failed
- The bash tool's `cp -l -b l l` and `cp -l -b l ./l`, `l` a symbolic link it follows that is its own destination, fail with `cannot create hard link 'l' to 'l': No such file or directory` (`'./l' to 'l'` for `./l`) and keep `l`, and `cp -s -b l l` makes `l` a link to `l` and keeps the old link as `l~`, as GNU's do (GNU backs `l` up by renaming it, then links), where both said `'l' and 'l' are the same file`. GNU's `cp -l --remove-destination l l` removes `l` and then cannot link to it; here it fails with the same message, and `l` stays
- The bash tool's `cp -s` of a relative source to a destination outside the working directory refuses (`can make relative symbolic links only in current directory`) before it backs up or removes the destination, so `cp -s -b a d` leaves `d/a` where it was, as GNU's does (GNU backs it up and renames it back), where it was left at `d/a~`. GNU's `cp -s --remove-destination a d` removes `d/a` before it refuses; here `d/a` stays
- The bash tool's `cp --attributes-only a ./a`, `a a` and the other names of the source's own entry, without a backup or `--remove-destination` (also with `-f` or `-P`), fail with `'a' and './a' are the same file`, as GNU's do, where they did nothing and exited 0
- Stated, unchanged: the bash tool's `cp -R d d` and `cp -R -t d d` fail with GNU's `cannot copy a directory, 'd', into itself, 'd/d'` and status 1 before they write anything. GNU first copies part of `d` into a new `d/d`, how much depending on the order it reads `d`, and leaves that partial copy behind
- The bash tool's `cp -u` compares in every mode, as GNU's does: with `-l`, `-s`, `--attributes-only` and `-R`, a destination that is not older than the source is kept and nothing is done, where `cp -u -l -f a b`, `cp -u -s -f a b` and `cp -R -u -l -f s t` replaced it with a link and `cp -u --attributes-only a b` copied the data into it, and `-i` asks only after `-u` compared, where `cp -u -l -i a b` replaced `b` without asking
- The bash tool's `cp` removes an existing destination before it writes the copy where GNU does: with `-a`, `-d` or `--preserve=links` when the destination has another link, and with `-R`, `-P` or `-a` when the source is not a regular file (a FIFO or a device with `--copy-contents`, a symbolic link). The destination's other links, and a file a link there leads to, keep their data, where `cp -a a b`, `b` another link of `c`, wrote into `c`, and `cp -R --copy-contents` of a FIFO or `/dev/null` wrote through a link at the destination
- The bash tool's `cp --attributes-only` copies no data in any case, as GNU's does: with `--remove-destination` it removes the destination and leaves an empty file with the source's attributes (also for `cp --attributes-only --remove-destination -fb a a`, at `a~`), where it copied the data; through a source link it follows it makes the destination, where it refused with `Source file is a non regular file`; and onto a followed source link that is its own destination with a backup, it fails with `cannot open 'l' for reading` as a copy does, where it said `'l' and 'l' are the same file`. Also as GNU's: `cp -R -u -b l l`, `l` a link, says `'l' and 'l' are the same file` before `-u` compares, where it exited 0, and `cp -l -i l a`, `l` a link to `a`, asks before it does nothing
- The bash tool's `find` and `fd`, `listWorkspace()`, and `grep()` with a match limit, over a tree more than 64 directories deep, no longer look every component of a directory's path up again for each directory below the 64th, which made such a walk take time quadratic in its depth where each lookup is slow, as under gVisor (`find` over 2,000 levels took 97 seconds there): each directory now opens relative to its parent, and a parent the walk returns to opens through its child's `..`, or below the walk's root once the walk enters one of its subdirectories, either way only with the device and inode it had (a directory made after that one was removed can get the same inode number, and is then taken in its place)
- Fixed writes by the bash tool's shell and its built-in utilities to a full pipe, FIFO or terminal waiting in the kernel on a thread that the rest of the shell needs, so that nothing else on that thread ran until the reader made room. Under gVisor (GKE Sandbox) a pipe reports room with one byte free, and a write of at most 4 KiB then waited until all of it fitted; on any system a status line or a utility's help text written to a full output pipe could do the same. These writes no longer wait on those threads on any platform: on Linux a pipe is written through a non-blocking reopen of it, and every other such write (macOS pipes and terminals, terminals and sockets elsewhere, and on Windows every descriptor that is not a regular file, a console on fd 1 or 2 included) goes to a writer thread of the descriptor's own or to the blocking pool; a write whose descriptor cannot be duplicated fails with that error and never waits on those threads. Only the Windows console opened as the shell's terminal (zsh's `SHTTY`, which the line editor and the job notices use) or as `/dev/tty`, a `ConsoleFile`, is still written with a synchronous `WriteFile` on the engine thread
- Fixed zsh `multios` (a command with two `>` targets, such as `cmd >a >b`) losing or reordering output when two writers shared it, such as a background program and a builtin, or a duplicated descriptor, while a target was slow: one writer's bytes could be skipped or reordered, a short write by the shell itself could be split by another writer's, and a writer could stay waiting after the target had room. The shell's tee now queues each write, sends the writes to every target in order, keeps whole a write of up to 4 KiB that the shell itself makes (a builtin's output, a diagnostic), and wakes every writer that waits on it. A program's output still reaches the tee in chunks of up to 64 KiB that the shell reads from the program's pipe, so a line of it can still be split by another writer's while a target is slow
- The bash and zsh shells' own reads of a process substitution or coprocess pipe that a program also holds take the next bytes, as bash's shell and its children read one pipe: `exec 4< <(…); prog <&4 & read v <&4` no longer waits for `prog` to end before it sees the bytes `prog` left unread. This needs a second read description of the pipe: Linux opens one through `/proc`, and macOS makes the pipe as a FIFO in the temporary directory. Where neither works (Linux without `/proc`, macOS when the FIFO cannot be made) and on Windows, the earlier behaviour stays.
- On Linux under gVisor, the bash and zsh shells no longer spin a CPU while they feed a slow reader through their pump (a process substitution, a here-document, a pipe the bash tool mirrors as a pipe stream): a write the pipe cannot take now is made by a thread of the pipe's own, which the kernel wakes once the write fits, where the pump retried it each time the pipe had room for any byte.
- Such a walk keeps walking the subdirectories of a parent whose read permission is taken away while the walk is below it, as the open through the parent's handle did: on Linux the parent opens again search-only (`O_PATH`), which needs only its search permission; elsewhere, and when that open fails too, each subdirectory not entered is reported with an error that names the parent, where it named the subdirectory
- The bash tool's `cp` reads its options as GNU cp does: `-P`, `-L` or `-H` after `-a` or `-d` changes only how links are followed and keeps the rest of `-a`/`-d`; `-n` is `--update=none`; the last of `-u` and `--update=WHEN`, and of `--backup=CONTROL`, decides; `-l`, `-s`, `--attributes-only` and `--copy-contents` no longer replace each other (`-l` with `-s` is refused); `-T` with `-t`, and a backup with `-n` or `--update=none-fail`, are refused with GNU's messages; `--copy-contents` applies only with `-R`; `--sparse=never` turns `--reflink=auto` off
- The bash tool's `cp` decides an existing destination as GNU does: `-n` and `--update=none` keep it before the same-file check; a directory there takes no non-directory once `-u` compared and `-i` asked, unless a backup is asked for, and a non-directory in a directory's way is backed up when one is; `--attributes-only` asks under `-i` and makes a link or a special file as a copy does; a link into a directory it cannot search gives `cannot stat`; a special file is made again without removing what is there first under `-L`/`-H`; a copied link replaces any destination that is not a directory (a FIFO, socket or device too), saying `removed` under `-v`; a file copied from a FIFO or a device gets the source's permissions; with `-p` and kin, a file written through a link at the destination gets the attributes on the link's target
- The bash tool's `cp` and `mv` put a backup back where the copy or move after it fails, as GNU's `un_backup` does: `cp -a -b /dev/null b` as a user that cannot make the device, and `mv -b` across filesystems from a source it cannot read, leave `b` with its name and data, and `-v` says `'b~' -> 'b' (unbackup)`; where the backup name is another link of `b`'s file, the copy gives the kernel's answer, as GNU's does (on Linux the rename does nothing and the copy then fails with "File exists", or replaces `b` under `-f` or `-i`)
- The bash tool's `cp --debug` and `-v` print what GNU prints for a copy that is refused, skipped or fails (`skipped 'b'`, the copy offload/reflink/sparse line of a failed or streamed copy), and `--reflink=never` copies with plain reads and writes, as GNU avoids the copy offload there
- The bash tool's `cp --reflink=always` reports the clone's own error, as GNU cp does (`Invalid cross-device link` across filesystems, `Operation not supported` on an overlayfs), where it said `source and destination are on different devices`. From a source that is not a regular file, such as `/dev/null`, it now tries the clone and fails as GNU cp does, where it copied the data and exited 0. With a backup (`-b`, `--backup=numbered`), a copy that fails renames the backup back, as GNU cp does, where the destination was left only under its backup name.
- The bash tool's `cp --reflink=always` onto a file with other hard links clones into that file, as GNU cp does, so every name of it gets the new data; it refused with `destination has other hard links`. Where the filesystem refuses the clone, the file keeps its data, where GNU's has been emptied.
- The bash tool's `cp --reflink=always` makes its clone, and any temporary file beside the destination, with mode 600, so no other user can open the source's data before cp sets the file's mode; it was 644 (666 less the umask). The tree clone of the isolation backend makes its clones the same way.
- The bash tool's `cp` with `-P`, `-R`, `-d` or `-a`, from a FIFO or a device it reads under `--copy-contents` or makes anew, onto an existing file, removes the file first and makes a new one, as GNU cp does (`removed` under `-v`): a link there keeps leading where it did, the file's other names keep their data, and the new file gets a new file's mode. It wrote into the existing file, or refused a link to nothing. `cp -al` run again onto its own copy still leaves a link that is already there.
- The bash tool's `cp --preserve=xattr` (and `-a`) sets a file's extended attributes before its final mode, as GNU cp does; it set the mode first and made a read-only copy writable again for them, which under gVisor failed with `Permission denied`. On Linux a new file is writable then; on macOS a clone of a read-only source is made writable through its descriptor for them and given its mode back; a file another user owns is left as it is. An attribute that cannot be set fails the copy of a file after its mode and times are set, as GNU's does.
- The bash tool's `cp -p` (and `--preserve=ownership`) from a FIFO whose name is removed while cp reads it gives the new file the FIFO's owner, mode and times, as GNU cp does from what it read of the FIFO; it set only the mode, less the umask.
- The bash tool's `cp` makes a new file as GNU cp does: with the source's permission bits, less its group and other bits while `-p` or `--preserve=ownership` may still change its owner, and its final mode is set after its owner, where it was readable by the group and others of the user running cp while it copied. A file made through a symbolic link that led nowhere (`POSIXLY_CORRECT`) gets the mode and owner a new file gets. A non-directory over a directory is refused with GNU's message after `-n`, `-i` and `-u`, also in a tree, where `-a` dropped the failure; with a backup the directory keeps its name.
- The bash tool's `cp` sets the owner, mode, times and extended attributes of a file it copied, cloned (`--reflink`) or opened under `--attributes-only` through that file's own descriptor, as GNU's `fchown`, `fchmod`, `futimens` and `fsetxattr` do, where it set them by name: a name replaced with a link after the copy wrote the file sent them to the link's target. Under `--attributes-only`, `-n` and `-i` decide first, so what they keep is kept. A new file made where a link was gets its final mode. Copying a tree with hard links onto its own earlier copy with `-a -f` exits 0, as GNU's does, where it failed with `cannot create hard link ... File exists`.
- The bash tool's `mv -i` answered no prints GNU's prompt alone, where it printed `mv: ` after it; `mv -T` of a non-directory onto a directory names the source in its refusal, as GNU 9.7's does; and `mv -v` across filesystems says what GNU's does: `copied 'a' -> 'b'` (with its backup, if any) and `removed 'a'` for a file; `created directory`, `copied` and rm's `removed` lines for a directory, whose entries are copied in GNU's order (by inode number), where it said `renamed` for each.
- `break` and `continue` in a forked pipeline element, a command or process substitution or a background simple command now act as bash and zsh run them: inside a loop they end that child without the `only meaningful in a loop` message (bash: a simple command, `$( )` and `<( )`; zsh: every fork), a count reaches loops past `eval`, and outside a loop the message is printed under the command's redirections, before its count is read, without dropping the rest of a `${ ;}` or `lastpipe` stage
- A pipeline element or background job that is a simple command with a `$( )`, backtick or `<( )` word is run as the simple command it is: it keeps bash's loop level (a `break` there ends only it), a builtin or external pipeline element's words see its parent's `$BASH_SUBSHELL`, and a `jobs` element keeps the job list
- A pipeline element that runs a function or a builtin is one subshell level down once its words are expanded, as in bash: a function, `eval` or `.` element (`f | cat`, `eval 'echo $BASH_SUBSHELL' | cat`) prints one more than its parent's `$BASH_SUBSHELL`, which it printed as its parent's; a substitution in its words is not raised with it
- The elements of a background pipeline (`f | cat &`, `{ …; } | cat &`, `( … ) | cat &`) are one subshell level down, as bash and zsh fork each element of an async pipeline once, not two; and zsh counts every pipeline element it forks (`$ZSH_SUBSHELL` is 1 in `echo $ZSH_SUBSHELL | cat`), a simple command too
- In bash mode a timed `( … )` job is one subshell level down, not two (`time ( echo $BASH_SUBSHELL ) &` prints 1), as bash forks the `( … )` once, as the job; and an and-or job that starts with a `( … )` is two down, not one (`( echo $BASH_SUBSHELL ) && : &` prints 2), as bash forks the whole list and then the `( … )`. zsh's counts, which differ in both, stay as they were
- A fatal error (an unset `${x?}`, `set -u`) in a pipeline element or background command of a `-c` string exits as bash's does: 127 from the command's own words, from a function it runs, from the own redirection of a compound that is the whole element or job (a timed one too: `time { :; } 2>"$w" &`) and from a negated job (`! f &`), when the shell that forked it would reach the command loop too; 1 from a builtin it runs (`eval`, `.`), a subshell, a list inside a compound element or a substitution, from the own redirection of a compound that is only the first command of a job's and-or list (`{ :; } 2>"$w" && : &`, timed or not), and from an element forked inside one of them (`x=$(f | cat)`, `( f | cat )`)
- `Process.terminate()` on Linux no longer leaves running a child that a process of a tree in a process group of its own (`ptree.spawn` with `detached`) forks while the tree is being read: each wave stops that tree, top-down, before it reads it and resumes it once signalled, so that child is signalled with its parent instead of outliving it under init (an aborted `ptree.spawn` command could keep its output pipe open until such a child ended). A tree in the caller's own process group is not stopped and keeps the walk and its race as before: on gVisor before google/gvisor 553528ee a stopped member of the caller's group brings SIGHUP to the caller as another member is reaped. A stopped process that blocks the wave's signal is let run, one step at a time, until it unblocks it, so a child it forks in that window is read too: dash blocks every signal around each vfork, and `sh -c 'sleep 30'` stopped there used to leave `sleep` running. Stepping one process ends once it has slept or run for 100 ms, so a process that blocks the signal and runs or sleeps longer than that before it forks still leaves its child running, and one that waits for the signal with it blocked (tini, a `sigwaitinfo` or signalfd reader) sleeps those 100 ms in the polite wave; the time a process waits for a CPU does not count, so a loaded machine ends no step early, and the steps of one process end after 5 s in all; a call with no grace period (`gracefulMs` below 0) steps no process; where the system shows no signal masks (gVisor) a stopped process is not stepped, so one stopped while it blocks the signal forks on after the wave resumes it, and those children outlive the termination unless `group` ends them: `fork` in glibc 2.41 and later blocks every signal around its `clone`, so a forking process stopped in that window makes one more child. The walk holds a pidfd for each process it reads, and a child whose pidfd cannot be opened (out of descriptors) leaves the walk incomplete, as any process it cannot read does. Each level of the tree waits until its processes have stopped: one that can run up to 5 s, since it stops the next time it runs, so a fork it was making has returned and its child is read; one asleep in the kernel (a vfork parent waiting for its child, a read of a disk) or traced up to 100 ms. One that has not stopped by then is read as it runs: a process the scheduler does not run within 5 s can complete a fork it was making, and that child outlives a termination without `group`. An abort signal that fires ends these waits and the steps at once: each process is read as it runs, and the wave's signal is still sent. A cancelled call also gives the tree no grace: its hard wave follows the polite one at once, so a child that would have exited on the SIGTERM within `gracefulMs` now dies of the SIGKILL instead.
- `Process.terminate()` sends its polite wave even when its abort signal has already fired, and an abort signal that fires before or during the grace period no longer skips the hard wave: it goes out at once, so a process that ignores TERM does not outlive the cancelled call, which then fails with the abort without waiting for the exits. Its hard wave also kills every process the polite wave signalled that still runs, and the tree under it: a child that ignores TERM, or was stopped, no longer outlives its parent's TERM under init, nor do the children it forked since. A process that was stopped before the walk is left stopped, not resumed. Without `group`, a process that forks during the grace period and then exits (in a TERM handler, say) still leaves its child out of reach: the child moves to the nearest subreaper or to init before the hard wave reads the tree. A caller that needs that child ended runs the command in a process group of its own (`group`, below), or under a subreaper (`ptree.spawn` with `subreaper: true`)
- `Process.terminate()` with `group` (`ptree.spawn` with `detached`) waits, through its grace period and its hard wave, until no process of the group is left, and sends the group its KILL again on each 50 ms tick while one is (a group whose members cannot be read counts as alive): a member that left the tree before the walk, or that a process of the tree forked during the grace period and then left, no longer outlives the termination under init. The grace period now runs in full while any member of the group ignores TERM, and the call returns `false` if a member is still running at the end of the hard wave's wait
- `Process.terminate()` whose polite walk could not read the whole tree (no descriptor left, say) now kills the process group the root led and fails even when the root and every process the walk read ended at TERM: a process it could not read, which ignored TERM, kept running while the call returned `true`. The group an incomplete walk signals is the one the root led when the call began, so a root that already ended, or that the hard wave's KILL ends first, no longer keeps it from being signalled
- `Process.terminate()` reads a process whose name is not UTF-8 (the kernel cuts a name at 15 bytes, inside a character too, and writes it into `/proc/<pid>/stat` and `status` unescaped): one such process anywhere on the machine no longer makes the group wait read every group as alive (group-mode `terminate` waited its whole bound and returned `false`), a child with such a name is pinned and ended like any other, and its stopped state and blocked signals read right
- External commands a shell starts on Linux with glibc no longer start with signals 32 and 33 ignored when the shell does not ignore them. Where `posix_spawn` does not use `clone3` (glibc before 2.38, or a seccomp profile that answers `clone3` with `ENOSYS`), glibc sets these two, its own signals, to `SIG_IGN` in the child before the exec, so `kill -s 33` could not end such a command; bash leaves them at their default. A shell program (`obash`) on glibc 2.34 or later that was started with them ignored passes that on, as bash does. This addon is the exception: it loads into a process that already runs threads, where glibc has replaced an inherited ignore of 33 with its own handler, so its commands get 33 at the default. On glibc 2.33 or older, glibc replaces both before any other code runs, so the commands of `obash` and of this addon get both at the default.
- The bash tool's `ps -M` lists a thread whose name is not UTF-8 (the kernel cuts a name at 15 bytes, inside a character too, and writes it into the thread's `/proc/<pid>/task/<tid>/stat` unescaped; a process's threads take its name); it left such a thread out, so a process of such a name had no thread lines. The end of a `locale` utility's process group counts a member whose main thread exited while another of its threads runs as live whatever its name, where a name that is not UTF-8 made it read as gone, so the end could stop while that thread ran. Both now read those files as bytes.
- `rm -f` now ignores only a name that names no file, as GNU rm does (an entry already gone, a path through a non-directory, or a name the filesystem rejects: ENOENT, ENOTDIR, EINVAL, EILSEQ), and reports every other error with exit status 1: a directory it cannot open or list (for want of a file descriptor, say) is named with that reason instead of being skipped and a directory above it reported as not empty, and an operand in a directory it may not search is reported instead of ignored. Without `-f` such an operand is reported with its own reason instead of "No such file or directory", and messages no longer end with ` (os error N)`
- `time` prints its report when its command leaves it by a jump, as bash does: a fatal expansion error (`( time echo ${x:?u} )`, `time cmd ${x:?u} &`, `set -u`, `$(( 1 / 0 ))`, also inside an array subscript's text), `exit`, `set -e` (also after an ERR trap), and `break` and `continue` (also from inside `eval`). Nested `time`s each report, innermost first, and the report comes before the EXIT trap runs. The report goes through the redirections in effect at the jump (`( time { exit 3; } 2>err )` writes it into `err`), except those of an `eval` or `.` the jump passes, which are undone first; while a function runs, `set -e` keeps those of the innermost `eval` or `.`, and `exit` keeps them all when an EXIT trap is set, so the report and the trap go through them (`f() { time eval '{ false; } 2>err'; }` under `set -e` reports into `err`). In a script's own commands (not under `-c`, `eval`, `.`, a trap action or a command or process substitution, nor in a child started inside one) an expansion error or a failed assignment undoes every redirection first, as bash's `top_level_cleanup` does, so `( time { echo ${x:?u}; } 2>err )` reports into `err` under `-c` and on the shell's stderr in a script. The error message goes through them either way (`( { echo ${x:?u}; } 2>/dev/null )` prints nothing). `return` and `exec` still give no report, as in bash, nor does a builtin that a `SIGPIPE` ends. An arithmetic subscript error (`a[1/0]=v`) reports only a script's own `time`s, none started in a `-c` string, `eval`, `.`, trap action or command or process substitution (or in a child started inside one), and a `time` that goes on after such an error reports its own times. `break` or `continue` run by `eval` outside every loop no longer ends the `eval`. An EXIT trap that is running counts as none, also in a subshell or a command substitution, until its action sets one again, so an `exit` in it undoes those redirections too. When `set -e`, a fatal expansion error, a posix special builtin's error or `break` with a bad count leaves a function, the EXIT trap runs outside it once bash's function context is gone (bash resets it, or each `eval`, `.`, `-c` string or command substitution the jump passes pops the functions called inside it), so `set -e` in the trap undoes them as well. `break` or `continue` with a count that is not a number undoes every redirection first, and only a script's own `time`s report. A posix shell's exit on a special builtin's error is `set -e`'s. Under `set -e`, an error bash reports with `report_error` (a readonly variable assigned, `set -u`, `${x:?}`, a bad array subscript, a list assigned to an array element (also `declare a[0]=(1)`), an associative array's element without a key or with an empty one, an invalid variable name, a `failglob` miss, a file `.` cannot read) exits the shell at once with no report, as bash does, also in `let`, `(( ))`, `read`, `printf -v`, `export`, `declare`, `local`, `.` and inside a condition, but not in an `eval`, `.` or builtin run through `command` (`command builtin export` too) that a condition runs; `builtin .` and `builtin eval` keep it. A discarded command (a failed assignment, an arithmetic subscript error, a `failglob` miss) in a subshell or a command substitution, also inside an `eval` or `.` there, now ends it and runs its EXIT trap, as bash does. That trap, and one a fatal error or `break` with a bad count runs, sees the functions bash leaves running (`FUNCNAME`, their locals and `$#`): each `eval`, `.`, trap action, command or process substitution or `-c` string the jump leaves ends the functions called inside it, and after an arithmetic subscript error, an integer variable's bad value (`local -i n; n=1/0`), `break` with a bad count, a function past `FUNCNEST` or an error in a script's own commands none runs, not even one the shell a subshell forked from was running. An integer variable's bad value in an assignment discards the command also in posix mode, as in bash.
- A command substitution lists the jobs bash 5.3 lists: in a shell that is not interactive it drops each finished job but the one `$!` names, keeping those a SIGINT, SIGTERM or SIGPIPE killed, and those a signal the shell ignores with `trap '' SIG` killed (by how the job ended, not its status: one that exited 130, 141 or 143 goes), as bash does before it runs the substitution's first command. A `( … )`, background job or pipeline stage of a `-c` shell drops its own finished jobs first, every one and `$!`'s too, as it expands a command or process substitution, and a command substitution's own process every one but `$!`'s, as bash does when it parses the substitution again there: `( …; x=$(jobs); jobs )` listed the finished jobs twice where bash lists none. In posix mode such a fork drops every one but `$!`'s, and a posix `-c` shell each one a signal killed but `$!`'s; a script file's shell and its forks drop none there, as bash's do. Where bash's job list is frozen (the last stage of a `lastpipe` pipeline, a function substitution `${ …; }`, a trap run with the list frozen, and any subshell, pipeline stage, background job or substitution forked from one of those) it drops none. `$(jobs)` with two finished jobs listed both, and a loop that waits for `$(jobs -p | wc -l)` to fall below a limit never ended. A dropped job keeps its status for `wait PID` there, `$!`'s too: `( …; x=$(wait $!) )` said `not a child of this shell`. `wait PID` or `wait %N` in a command or process substitution of a finished job it took from its shell returns that job's status, where it said `not a child of this shell`. A process substitution lists the same jobs: `cat <(jobs)` listed none, and in a `( … )` it listed `$!`'s job.
- A fork started where bash keeps its job list frozen (the last stage of a `lastpipe` pipeline, a function substitution `${ …; }`, a trap run with the list frozen) keeps that freeze for its whole life, as bash's fork keeps `jobs_list_frozen`: a command or process substitution, `( … )`, `{ …; } &` group or pipeline stage started there deletes no job after `wait`, `wait PID`, `wait %N`, `disown`, `kill` and `wait`, or a `CHLD` trap, so its `jobs` lists them; `wait -n` returns 127 at once under `lastpipe` and takes and marks a finished job under `${ …; }`. The innermost freeze counts (`wait -n` in a function substitution inside a `lastpipe` stage takes a job). While no job may be deleted, each foreground command forked (an external, a `( … )`, a pipeline) keeps its job number, so `y=${ /bin/true; /bin/true; sleep 1 & jobs; }` shows `[3]+`. A function substitution marks the finished jobs it reports, and the first clean-up after it deletes them. A plain `wait` there marks the finished jobs it forgets, as bash does, so a later `jobs -n` no longer lists them.
- `time ( … )` times the subshell inside its fork, as bash does: the report goes through the subshell's own redirections (`time ( … ) 2> e` reports into `e`, and one that fails, as in `time ( … ) < /no/such`, leaves no report), uses the subshell's `TIMEFORMAT`, and comes before its EXIT trap; a body that is one `( … )` alone passes the time on, and a `time` inside it makes no second report. `exec`, a killed subshell and a closed standard error leave no report, and once a subshell, job, pipeline stage or command substitution has run `trap`, a jump out of a `time` it started before reports nothing. When a posix-mode special builtin's error (its usage error, or a redirection of its that fails) ends the shell, the builtin's own redirections are undone before the report, as bash does: `set -o posix; time { trap INT 2>/dev/null; }` reports on standard error.
- `unset` of a variable that a prefix assignment gave a temporary value (`x=3 eval 'unset x'`, `x=3 . file`, `x=3 f` for a function) removes the temporary, as in bash: the variable it hid shows through, a second `unset` removes that one too, and the name is no longer listed as `declare -x x`; a `local` of the function, and a calling function's under `localvar_unset`, still stays declared but unset
- bash mode: a negated compound command whose own redirection fails (`! { …; } < missing`, `! ( … ) < missing`, `! while …; done < missing`) ends with status 1, as bash's does: the failure comes before the `!` applies. `PIPESTATUS` after a subshell whose own redirection fails holds the subshell's status (1, or 0 when negated).
- A FIFO redirection a killed job had waiting on (`cat < f & kill %%`) no longer makes the next command's open of that FIFO read end of file at once, which left the next writer (`echo hi > f`) waiting for ever, when another session of the process started a program while the job was ended. The end the shell opens to release such a wait is held where a process started meanwhile does not get a copy of it (Linux).
- Starting or restoring an embedded shell session, applying `rsync --chmod`, or running another host that needs the process's file-creation mask no longer forks the whole process where `/proc/self/status` has no `Umask` line, as under gVisor: it is read with a short-lived child that shares this process's memory and descriptor table but has a mask of its own (Linux), so no child copies every open file of the host
- A builtin given more arguments than it takes (`suspend`, `shift`, `return`, `exit`, `break`, `continue`), an arithmetic subscript error (`a[1/0]=v`, `${a[1/0]}`, `$(( a[1/0] ))`, `read 'a[1/0]'`, `printf -v 'a[1/0]'`, `let`, `declare`, `local`, `unset`, `(( ))`, `[[ ]]`, `test -v`, `{a[1/0]}>`, also in posix mode), an arithmetic error in a value assigned to an integer variable (`declare -i x; x=1/0`, `x+=1/0`, an element or compound value, `declare`, `local`, `read`, `printf -v`, `mapfile`, `export`, `readonly`, a `for` variable, `${x:=1/0}`; a builtin keeps its name in the message) and a function called past `FUNCNEST` drop the rest of the line as bash does (`top_level_cleanup` or `run_unwind_protects`, then `jump_to_top_level (DISCARD)`), also through every function, `eval` and `.`: a `-c` string ends with status 1, a script goes on with its next line (status 2 after too many arguments, else 1), a subshell exits (running its EXIT trap outside every function, also those of the shell it forked from), and a command or process substitution exits with status 1. They used to drop at most the innermost `eval` or `.` string, or go on: `break 1 2` in a loop ran every pass, `read 'a[1/0]'` and `unset 'a[1/0]'` went on with their next command, and `{a[1/0]}>` also printed `cannot assign fd to variable`. The `{var}` redirection of a command that bash forks before its redirections (an external, `command`, a name not found, a `( … )`) fails only that command, with status 1, and the line goes on, as only bash's fork ends. `break` and `continue` outside every loop read no arguments, as bash's `check_loop_level` comes first. A prefix assignment (`x=1/0 cmd`) puts its value in the command's environment as written, without the variable's integer or case attributes, as bash's `assign_in_env` does; only `x+=… cmd` applies them.
- A compound word given to `declare`, `typeset`, `local`, `export` or `readonly` (`name=(…)`) that bash cannot declare or assign drops the command, as bash does while it is still expanding the words, before the builtin runs (`exp_jump_to_top_level (DISCARD)`): an associative array's empty key (`declare -A A=([k]=v []=x)`), a list for an element (`declare a[0]=(1)`), any other element bash refuses (`[-9]=x`, `[@]=x`, a word without a key), a readonly variable and an array of the other kind (`declare -A i=(…)` on an indexed `i`). Only that command is dropped: an `eval` or `.` goes on with its next command, a script or `-c` string with its next line, and a subshell exits with status 1; in a script's own commands bash's `top_level_cleanup` comes first (the redirections are undone, a subshell's EXIT trap runs outside every function). In a function, `declare`, `typeset` and `local` go on after a readonly variable or an array of the other kind, and report it again under their own name. They used to go on with status 1. The compound words of one command are assigned before its other arguments, as bash assigns them while it expands the words: `declare x=1 A=([]=v)` sets no `x`, and `declare -i n=5 a=(n)` gives `a` 0. A compound assignment stops at its first bad element (bash 5.3), also in a plain assignment (`a=(1 [-9]=x 3)` keeps only `1`), where it used to assign the elements after it. A message made while bash expands a declaration's words is named by the function, `eval` or `.` around it only until a simple command inside it ends, then by none (bash's `this_command_name`; `((` and `[[` set it, a `for` item clears it), no longer by any running function. Too many arguments, an arithmetic subscript error or a function past `FUNCNEST` inside a running EXIT trap ends the trap, and the shell exits with the status bash's `run_exit_trap` takes then, where it used to exit with the error's status: the `$?` the last trap that started saved, the EXIT trap's own unless a signal, ERR or DEBUG trap ran inside it (bash keeps one `trap_saved_exit_value`). A subshell's own trap does so unless the subshell was forked inside an older level that still runs: an `eval`, `.`, other trap action or substitution's text, or the `-c` string (the shell's own `-c` string has ended by the time its EXIT trap runs). There it exits with the error's status, 1 under `-c` or in a substitution's text. The same error in the body of a subshell, job, pipeline stage or substitution forked inside an EXIT trap action, where that action is the outermost level, ends the child with that saved status, without running the child's own EXIT trap, as bash returns into the trap the child was forked in; it used to exit 1 under `-c` and 2 from a script after too many arguments. A command or process substitution forked inside an `eval`, `.` or trap action keeps that level, so such an error in it ends it with the error's status (2 from a script), as in bash 5.3, where it ended with 1. A RETURN trap runs with `$?` and `PIPESTATUS` as they were before the function or `.` file returned, as bash's `return` sets only the status the call returns; it used to see the return status (`f() { return 5; }` gave the trap `$?` 5, where bash gives the caller's 0), and an EXIT trap that called such a function ended with that status.
- A quote (`'`, `"` or a backquote) that opens a line and that the input ends inside is reported on that line, as bash reports it (`parse_matched_pair` starts at the line it read the quote on), in a script, a `-c` string, a compound assignment and a compound array value given as a string. It used to be reported on the line before.
- A compound array value given to `declare`, `typeset`, `local`, `export` or `readonly` as a string that does not parse (`declare -a a='(1 "2)'`, `declare -a a='(a;b)'`) is reported as bash reports it, `NAME: array assign: line N: …` (an end-of-input error names the string's own line; a token error the command's line plus the string's, less one, and the string's line that holds the token follows), and drops the command as bash does (`parse_string_to_word_list`: a plain `DISCARD`): an `eval` or `.` goes on with its next command, a script or `-c` string with its next line, and a subshell exits with status 1. A non-interactive posix shell exits (127 from a `-c` string, else 1), and under `set -e` the shell exits with status 2 after the first line. The error used to be reported under the builtin's name, and the command went on with status 1.
- The embedded shell runs a forked command's own EXIT trap where bash does: a `( … )` subshell, a coprocess, a simple command's fork, a substitution, and a `{ …; }` group that is async with no pipe or in a pipe and not async. A trap set inside a forked `if`, `case`, `while`, `until`, `for`, or inside a group that is both piped and async, no longer runs when that child ends, so a cleanup trap in a piped or backgrounded loop body no longer fires early.
- bash mode's notice of a timed `( … )` a signal killed names it as bash does, with its `time` first: `time ( kill -9 $BASHPID )` prints `bash: line 1: PID Killed … time ( kill -9 $BASHPID )`, `time -p ( … )` keeps its `-p`, and a `time` a `( … )` passes on to the one `( … )` its body is shows on that one; the `time` was left out. A timed `( … )` that is a `( … )`'s whole body (`time ( ( … ) )`, `( time ( … ) )`) is now a process of its own, as bash forks it (`CMD_TIME_PIPELINE` keeps it from `CMD_NO_FORK`): when a signal kills it, the outer `( … )` reports it, through its own redirections, and exits with its status, where the outer died with it and the shell named the outer.

## [18.18.6] - 2026-11-09

### Fixed

- Fixed GTK4 apps such as Files (Nautilus) on X11: element clicks and `computer.elementAt()` now find their elements where they are on screen, and `ax()` no longer marks their enabled controls `(disabled)` ([#18643](https://github.com/can1357/oh-my-pi/pull/18643) by [@will-bogusz](https://github.com/will-bogusz))
- `grep` no longer searches the file its own output is redirected into, nor standard input redirected from that same file: both are refused with `input file is also the output`, as GNU grep does ([#14808](https://github.com/can1357/oh-my-pi/issues/14808), [#16489](https://github.com/can1357/oh-my-pi/pull/16489) by [@yuzu-octopus](https://github.com/yuzu-octopus))

## [18.18.2] - 2026-11-08

### Added

- Added Zig syntax highlighting for fenced Zig code in Markdown.
- Added `Shell.fork()`, a new shell whose session starts from this one's variables, functions, aliases, options, and working directory as of its last command boundary, without waiting for a command in flight.

### Fixed

- Built-in jq filters now stop reliably when aborted or timed out, even before producing output.
- Fixed logical directory changes with cd and pwd in native Windows shell sessions, including drive and UNC paths.
- Fixed closed file descriptors passed to external commands on Unix so writes fail as expected; closed standard streams on Windows now use the null device.
- Fixed setValue() on Linux reporting success when Firefox or Thunderbird fields, including password fields, were not actually updated; failures now identify the affected field appropriately.

## [18.18.1] - 2026-11-08

### Added

- macOS `ax()` lines show what an element can do: `(selected)`, `(settable)` on dates `setValue` can write, `(readonly)` on web text fields the page locks, `actions=` beyond its press, and names for unlabeled window buttons ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- macOS `ax()` lines show 200 characters of a long label or value instead of 80, keep newlines as `\n`, and end a cut value with the call that reads it whole ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))
- macOS `ax()` dates read in local time with their offset, the form `setValue` takes back, and `axPerform` runs a listed action in any case, with or without its `AX` prefix ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))
- macOS background left drags across the text of one native text view, such as a TextEdit document, now select that text through accessibility, and `drag` resolves to `{ selection, focusReturn }`; drags on web page text and links still throw `BackgroundUnavailable` ([#16223](https://github.com/can1357/oh-my-pi/pull/16223) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- macOS `ax()` no longer marks every cell of a focused table or sidebar `(focused)`; only the element holding the app's keyboard focus is ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))
- macOS `axPerform` reports a followed Preview PDF link or an opened Finder item as unconfirmed instead of failed ([#15282](https://github.com/can1357/oh-my-pi/pull/15282) by [@will-bogusz](https://github.com/will-bogusz))
- The embedded shell's `comm` merges in the same locale order as its `sort`, so `comm` on `sort` output under a UTF-8 locale no longer reports unsorted input and drops common lines
- An edit whose path is missing on disk no longer stalls the embedded shell and other native calls while it searches for the file, and a cancelled edit stops that search at once ([#18386](https://github.com/can1357/oh-my-pi/pull/18386) by [@sjawhar](https://github.com/sjawhar))
- macOS spellchecking (typo underlines, autocorrect, `apple` word completion) no longer leaks native memory for the life of the process ([#18285](https://github.com/can1357/oh-my-pi/pull/18285) by [@aleister1102](https://github.com/aleister1102))
- Fixed large brace expansions running as literal text or silently dropping words: expansions support up to 4,194,304 words and report an error above that limit ([#18092](https://github.com/can1357/oh-my-pi/pull/18092) by [@sjawhar](https://github.com/sjawhar))

## [18.18.0] - 2026-11-07

### Fixed

- Fixed `find()` missing elements more than 24 levels down, such as VS Code's editor; it now searches 64 levels deep ([#18221](https://github.com/can1357/oh-my-pi/pull/18221) by [@will-bogusz](https://github.com/will-bogusz))
- `glob`, `grep`, `fuzzyFind`, `ast_grep` and `ast_edit` now run their directory traversal on a filesystem runtime of their own, so a search over a large or cold tree can no longer take the worker threads that the embedded shell and every other native call are scheduled on. Those threads are named `pi-fs-worker`, so a stall in a search is tellable apart from a stall elsewhere.
- Fixed a workspace tree whose native addon does not match its checkout failing with `undefined is not a constructor` at the callsite: a class the addon lacks now throws a message naming the addon file, both releases and `bun run build:native` — from its constructor and from any static entrypoint — and the loader reports that mismatch once as it loads ([#18230](https://github.com/can1357/oh-my-pi/pull/18230) by [@sjawhar](https://github.com/sjawhar))

## [18.17.0] - 2026-11-06

### Breaking Changes

- Replaced `parseShell()` with `RunTrace.present()` and `ShellVisualization`.

### Added

- Added `RunTrace`: command states, variable assignments, per-producer output, bounded replay, Raw/Pseudo presentation, and restoring persisted traces.
- Added `obash --trace=PATH` to write a JSON execution trace at exit; `UnitCompiled` events now include source node tables.
- `Shell` and `executeShell` now run pi-shell's Bash engine with Bash 5.3 semantics, including aliases containing pipelines, subshells, and separators.
- Native shell is faster across parsing, functions, expansion, redirections, arithmetic, loops, and external command startup.
- Sixel image output now uses a built-in encoder.
- Built-in `ps -o` accepts Apple's `utime` (alias `putime`) for user CPU time, instead of failing with `unknown output format specifier 'utime'`.
- Shell spawn benchmarks now report median and p99 latency.

### Changed

- Built-in `jq` now reports errors as plain text with `line:column` locations.
- Work-profile flamegraphs are now static SVGs with hoverable titles.
- Built-in `grep -r`, `rg`, `find` and `fd` are faster on small and large trees and stream output to pipes in batches.

### Fixed

- Fixed a crash on Linux when a zsh-mode sort or `strftime`/`$langinfo` named a locale that is not installed.
- Fixed `env -i` in the bash tool passing exported shell functions (`BASH_FUNC_name%%`) and non-environment shell variables to the command.
- Fixed `$!` in command substitutions, subshells and pipeline stages to name the parent's last background job, as in Bash ([#18107](https://github.com/can1357/oh-my-pi/pull/18107) by [@sjawhar](https://github.com/sjawhar))
- Fixed built-in local `rsync` output on a busy machine sometimes differing from rsync 3.5.1: `--delete`/info lines from subdirectories could print after the top-level names and the byte totals in `sent … received …`/`--stats` could be off by 4.
- Fixed Windows `rsync` treating a one-letter daemon host like `h::module` as a drive path ([#18048](https://github.com/can1357/oh-my-pi/pull/18048) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed git, its helpers and commit hooks started by omp reading the terminal, which could swallow keystrokes and leave Tern protocol text like `_tsp;e;{"ev":"ack",…}` in the composer; they no longer inherit the terminal or share its session.
- Fixed `ssh` started by the built-in `rsync` (and `sort --compress-program`) prompting on the user's terminal, e.g. host-key confirmations appearing after exit; they no longer share omp's terminal or session.
- Fixed history saves hanging when a stale lock cannot be removed.
- Fixed native addon startup on glibc 2.17–2.28, which lacks `posix_spawn_file_actions_addchdir_np` ([#18046](https://github.com/can1357/oh-my-pi/pull/18046) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed Windows `rmdir` accepting trailing-dot or trailing-space operands that could remove a different directory ([#18047](https://github.com/can1357/oh-my-pi/pull/18047) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed `timeout`, `nohup`, `git` and similar utilities inside shell functions skipping operands or running the function's arguments ([#18030](https://github.com/can1357/oh-my-pi/pull/18030) by [@sjawhar](https://github.com/sjawhar))
- Fixed native Windows commands not resolving executables via `PATH`/`PATHEXT`, and absolute paths being prefixed with the cwd ([#18041](https://github.com/can1357/oh-my-pi/pull/18041) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed minimized `git stash pop` and `git status` counting status lines and "Dropped" notices as untracked files ([#18159](https://github.com/can1357/oh-my-pi/pull/18159) by [@eggpeat](https://github.com/eggpeat))
- Fixed associative arrays slowing quadratically: 100,000 inserts and lookups drop from ~90 s to ~0.1 s.
- Fixed GTK3 Open/Save dialogs on Linux: `ax()` and element input work, and Wayland window lists include them ([#18011](https://github.com/can1357/oh-my-pi/pull/18011) by [@will-bogusz](https://github.com/will-bogusz))
- `capabilities()` now reports `input: false` and `inputPermission: "unavailable"` on Wayland without a RemoteDesktop portal (e.g. sway); input fails immediately ([#18012](https://github.com/can1357/oh-my-pi/pull/18012) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `.bzl` files being treated as Python instead of Starlark in `ast-grep`, `astGrep`, `astEdit`, and code summaries ([#18145](https://github.com/can1357/oh-my-pi/pull/18145) by [@eggpeat](https://github.com/eggpeat))
- Minimized `rustfmt --check` output now reports how many files need formatting instead of miscounting diff locations ([#18147](https://github.com/can1357/oh-my-pi/pull/18147) by [@will-bogusz](https://github.com/will-bogusz))
- Minimized `git diff`, `git show` and `diff -r` now list binary files (as `Bin`), pure renames and mode-only changes ([#18148](https://github.com/can1357/oh-my-pi/pull/18148) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Wayland `el.type` and `el.press(keys)` shifting the app's focus before refusing; they now refuse first ([#17915](https://github.com/can1357/oh-my-pi/pull/17915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Windows background drags in Tk apps reporting success while doing nothing; they now follow `computer.backgroundFallback` ([#17913](https://github.com/can1357/oh-my-pi/pull/17913) by [@will-bogusz](https://github.com/will-bogusz))
- Built-in `rsync` now matches rsync 3.5.1 for unopenable `--log-file` errors; empty `--log-file=` logs to syslog ([#17980](https://github.com/can1357/oh-my-pi/pull/17980) by [@sjawhar](https://github.com/sjawhar))
- Fixed X11 takeover and `raise()` failing on a window previously targeted by background typing, e.g. under Openbox ([#17910](https://github.com/can1357/oh-my-pi/pull/17910) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed X11 background keys into Qt 5/6 apps silently doing nothing; they now use takeover, or refuse when `computer.backgroundFallback` is `refuse` ([#17911](https://github.com/can1357/oh-my-pi/pull/17911) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Wayland `doubleClick` and `click` with `count` registering as a single click in KDE Plasma Qt apps ([#17903](https://github.com/can1357/oh-my-pi/pull/17903) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `press()`, `perform()` and `menu.select()` failing on Linux in browsers, VS Code, LibreOffice and non-English locales; `press()` now toggles toggle/radio buttons ([#17936](https://github.com/can1357/oh-my-pi/pull/17936) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `computer.focusedWindow()`, `ax()` and `observe()` on GNOME/KDE Wayland reading a shell surface instead of the focused app ([#17922](https://github.com/can1357/oh-my-pi/pull/17922) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed takeover keys into iPhone Mirroring and Screen Sharing leaving Fn held, dropping Shift and later letters ([#17909](https://github.com/can1357/oh-my-pi/pull/17909) by [@will-bogusz](https://github.com/will-bogusz))
- An unanswered Wayland RemoteDesktop permission dialog now fails input with `Timeout` before the run deadline, sending nothing ([#17932](https://github.com/can1357/oh-my-pi/pull/17932) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed X11 takeover input stopping with `Cancelled` after you typed locally; Escape now stops computer use for the rest of the turn ([#17912](https://github.com/can1357/oh-my-pi/pull/17912) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed X11 background `el.type`/`el.press` raising the window and taking your keyboard; elements without GTK 3 focus now use takeover ([#17921](https://github.com/can1357/oh-my-pi/pull/17921) by [@will-bogusz](https://github.com/will-bogusz))

## [18.16.0] - 2026-11-02

### Added

- Added `macOSFrontApp()`, which reads the app macOS has in front and can put it back in front for a while (`keepInFront`) without stopping for the user's typing ([#16284](https://github.com/can1357/oh-my-pi/pull/16284) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed iPhone Mirroring clicks, scrolls and keys reporting success while the mirror showed a connection screen such as "iPhone in Use" instead of the phone; they now fail and quote that screen ([#17755](https://github.com/can1357/oh-my-pi/pull/17755) by [@will-bogusz](https://github.com/will-bogusz))
- `parseKey`/`matchesKey` now recognize the parameterless `CSI P`/`CSI Q`/`CSI S` (and `CSI 1 <letter>`) forms that kitty-protocol terminals such as Ghostty send for unmodified F1/F2/F4, and modified F2–F9 no longer match other keys (e.g. Ctrl+PageDown as Ctrl+F8) ([#17812](https://github.com/can1357/oh-my-pi/issues/17812)).
- Added `installSqliteLockShim()` (Linux), which moves Bun's SQLite record locks onto open-file-description locks that no other close of the file releases, and `heldFileKind(path)`, which reports a file this process holds open and locked. Both are also on `@oh-my-pi/pi-natives/sqlite-locks`, which loads the addon on first call ([#15586](https://github.com/can1357/oh-my-pi/issues/15586))

## [18.15.0] - 2026-11-01

### Fixed

- Fixed the bash tool's shell stopping with status 1 and no message after about 40 levels of nested functions, `eval` or `source` when the process may open only 1,024 files; a shell that runs out of open files now says so and names the limit to raise ([#17668](https://github.com/can1357/oh-my-pi/pull/17668) by [@sjawhar](https://github.com/sjawhar))
- `bun check` now runs the Rust half when your branch commits a Rust change on a clean tree, skips it on a TypeScript-only branch even under `CI=true`, and prints one line saying which it did and why (`OMP_FORCE_RUST_TASKS=1` always runs it) ([#17628](https://github.com/can1357/oh-my-pi/pull/17628) by [@sjawhar](https://github.com/sjawhar))

## [18.14.2] - 2026-10-31

### Added

- Added `listWorkspace({ pruneExcludedDirs: false })` to stop pruning standard dependency/build directory names; hidden directories such as `.git` also require `hidden: true` ([#17539](https://github.com/can1357/oh-my-pi/issues/17539))

## [18.14.1] - 2026-10-31

### Added

- Added `FileLock.isHeld(path)`, which reports whether a lock is held without acquiring it ([#17428](https://github.com/can1357/oh-my-pi/pull/17428) by [@andrebrait](https://github.com/andrebrait))

### Fixed

- Fixed native search on Windows (the bash tool's `fd`, grep, glob) failing with "The filename, directory name, or volume label syntax is incorrect" or "path not found" for paths with `.`/`..` components or `/` separators, including `fd` run without a search path
- Fixed glob and find on Windows reporting a symlinked file's own size and mtime instead of its target's, which dropped linked files from listings that skip empty files
- Fixed the bash tool's built-in `rsync` on Windows ignoring per-directory merge files whose name includes a directory part, such as `--filter=':- ../rules'`

## [18.14.0] - 2026-10-29

### Breaking Changes

- Removed the `invalidateFsScanCache` API and the associated filesystem scan cache environment variables (`FS_SCAN_CACHE_TTL_MS`, `FS_SCAN_EMPTY_RECHECK_MS`, `FS_SCAN_CACHE_MAX_ENTRIES`, and `FS_SCAN_CACHE_MAX_BYTES`); filesystem listing caches are now managed automatically.

### Added

- Added a built-in `rsync` implementation to the bash tool, compatible with rsync 3.5.1 and protocol versions 29–33 across Linux, macOS, and Windows. It supports local copies, SSH remote shells via `-e`, and `rsync://` daemons without requiring an installed binary; daemon serving is not supported, and `PI_DISABLE_UUTILS_DESTRUCTIVE` continues to use the system `rsync`.
- Added built-in `ast-grep` (also available as `sg`) support to the bash tool for structural code search and rewriting, including pattern matching, rewrites, context, headings, and JSON output.

### Changed

- Improved native filesystem search performance, including faster globbing and more efficient grep, fuzzy finding, workspace listing, and structural search/edit operations, while preserving deterministic result ordering and streaming behavior.
- Native search and the bash tool's built-in `rg`, `grep`, `fd`, `find`, and `ast-grep` now stop filesystem work promptly when cancelled or timed out, including searches over JavaScript-provided filesystems and searches interrupted while reading large files.
- The bash tool's built-in `rg` and recursive `grep` now search files in parallel while retaining path-ordered output; `grep` can also stop promptly after reaching `maxCount`.
- Enabled safe reuse of unchanged directory listings when `cache: true`, with timestamp validation to prevent stale results.

### Fixed

- Fixed cancelled native directory searches leaving filesystem-provider requests running during startup.
- Fixed built-in bash commands such as `cat`, `grep`, `head`, `wc`, `read`, and `mapfile` hanging at the end of FIFO input on macOS; `read -t` now returns at EOF.
- Fixed ANSI text wrapping for styled underlines, background colours, and colon-form RGB colours.
- Fixed clicking in native audio playback when the queue runs dry mid-waveform by smoothly fading output to silence and back.

## [18.13.3] - 2026-10-28

### Changed

- Updated Bun engine requirement to ≥1.4.4

## [18.13.2] - 2026-10-27

### Added

- Added opt-in, cycle-safe descendant-link traversal to native `glob` through `followLinks`, leaving default traversal unchanged ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))

### Changed

- Faster native line, word, and structured patch diffs on large edits ([#17015](https://github.com/can1357/oh-my-pi/pull/17015) by [@GTanger](https://github.com/GTanger))

### Fixed

- Fixed the built-in `sort` using many times its `-S` buffer size, or more memory than its container allows or the machine has available, on inputs of short lines, and ignoring `timeout` or a cancel while it sorts ([#17155](https://github.com/can1357/oh-my-pi/pull/17155) by [@sjawhar](https://github.com/sjawhar))
- Fixed the built-in `sort -m` and `sort -c` splitting lines longer than their read buffer, and `sort` joining a file's unterminated last line to the next file's first line ([#17155](https://github.com/can1357/oh-my-pi/pull/17155) by [@sjawhar](https://github.com/sjawhar))
- Fixed the built-in `sort -S N%` using the wrong buffer size: `-S 50%` gave 0 bytes and `-S 100%` a thousand times the machine's memory; it is now N percent of physical memory as in GNU sort ([#17155](https://github.com/can1357/oh-my-pi/pull/17155) by [@sjawhar](https://github.com/sjawhar))
- Exited bash-tool `&` jobs are reaped without another command; `wait` still reports their status, and `$!` works inside pipelines, subshells, and command substitutions ([#17144](https://github.com/can1357/oh-my-pi/issues/17144)).
- On macOS, the bash tool's built-in `ps` includes other users' processes and unreaped zombies when selecting a PID ([#17144](https://github.com/can1357/oh-my-pi/issues/17144)).
- Fixed native `glob` file-type filters discarding target size and modification time for linked files ([#17180](https://github.com/can1357/oh-my-pi/pull/17180) by [@alphastorm](https://github.com/alphastorm))
- Fixed leading UTF-8 BOMs causing embedded `jq` JSON input parse errors while preserving raw-input bytes ([#17179](https://github.com/can1357/oh-my-pi/pull/17179) by [@alphastorm](https://github.com/alphastorm))
- Fixed the shell's `timeout` and tool aborts not stopping built-in commands that were still reading (`cat /dev/zero`, huge files, FIFOs with no writer) ([#17141](https://github.com/can1357/oh-my-pi/pull/17141) by [@sjawhar](https://github.com/sjawhar))
- Fixed a tool abort leaving a background in-process command, such as `cat /dev/zero > /dev/null &`, running and keeping a core busy after its shell session was gone ([#17141](https://github.com/can1357/oh-my-pi/pull/17141) by [@sjawhar](https://github.com/sjawhar))
- Fixed a shell redirect to or from a FIFO whose other end is a background job, such as `echo hi > f & cat < f`, hanging the command; a tool abort now also stops a write redirect to a FIFO that has no reader ([#17141](https://github.com/can1357/oh-my-pi/pull/17141) by [@sjawhar](https://github.com/sjawhar))
- Fixed a background external command with a FIFO redirect, such as `/bin/cat < f & echo hi > f`, hanging the shell until the FIFO's other end opened; the command's own process now opens it, as in bash ([#17141](https://github.com/can1357/oh-my-pi/pull/17141) by [@sjawhar](https://github.com/sjawhar))
- Fixed `timeout` printing `error: interrupted` when its limit stopped a built-in command; like GNU `timeout`, it now prints nothing of its own and exits 124 ([#17141](https://github.com/can1357/oh-my-pi/pull/17141) by [@sjawhar](https://github.com/sjawhar))
- Fixed crackling in live voice playback: the assistant's speech now absorbs packet jitter without dropping out, short turns play without waiting for the next response, and lost packets no longer insert extra synthesized audio ([#17114](https://github.com/can1357/oh-my-pi/issues/17114))
- Fixed the bash tool's `rm -r` and `du` crashing the whole session with a stack overflow on a directory tree thousands of levels deep; `rm -r` also removes such a tree without running out of file descriptors, and reports a directory that is its own ancestor instead of descending into it ([#17021](https://github.com/can1357/oh-my-pi/pull/17021) by [@sjawhar](https://github.com/sjawhar))
- Fixed the bash tool's `find` panicking and writing a native panic report to `~/.omp/logs` when the command reading its output exits early, as in `find . -printf '%p\n' | head -1`, or when its stderr is closed; it now stops quietly, and a failed `-fprintf` write is reported instead of `find: internal error` ([#17079](https://github.com/can1357/oh-my-pi/pull/17079) by [@trukhinyuri](https://github.com/trukhinyuri))
- Fixed the shell's built-in `grep` and `rg` running the whole agent out of memory on a file with no line breaks, such as a large sparse file: a line over 256 MiB is now reported as `not searched` for that file and the search continues, and a `-f` pattern file over 256 MiB is refused with exit status 2 ([#17108](https://github.com/can1357/oh-my-pi/pull/17108) by [@sjawhar](https://github.com/sjawhar))
- Fixed the embedded shell's globs keeping matches whose literal tail does not exist: `ls -d DIR/*/` now lists only directories instead of passing every file as `file/`, and `*/name` keeps only matches that contain `name`, as in bash ([#17110](https://github.com/can1357/oh-my-pi/pull/17110) by [@sjawhar](https://github.com/sjawhar))
- Fixed the embedded shell ignoring `shopt -s globstar`: `**` now matches any number of directory levels as in bash (`**/*.rs` finds files at every depth, also in `compgen -G`), and a timeout or interrupt stops a long `**` expansion ([#17111](https://github.com/can1357/oh-my-pi/pull/17111) by [@sjawhar](https://github.com/sjawhar))

## [18.13.0] - 2026-10-26

### Added

- A failed `EditStore.apply` outcome carries `errorKind`, a stable class of the refusal (`unseen_lines`, `stale_tag`, `parse`, …), and `editErrorKinds()` lists every class ([#16608](https://github.com/can1357/oh-my-pi/pull/16608) by [@will-bogusz](https://github.com/will-bogusz))
- Added `exclude` to `grep()` options: glob patterns of files and folders to leave out of a directory search; a matched folder is not walked ([#16920](https://github.com/can1357/oh-my-pi/pull/16920) by [@will-bogusz](https://github.com/will-bogusz))
- On macOS, `openApplication` also opens a file, folder or URL in its default application or `ApplicationOpenOptions.app`, and `reveal` shows a file or folder selected in Finder; other platforms return `Unsupported` for a URL, `app` or `reveal` ([#16403](https://github.com/can1357/oh-my-pi/pull/16403) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a rerouted parallel Mermaid flowchart edge running over other edges, ports and labels at the same two nodes; the route no longer depends on declaration order, and it can pass outside the first row or column of nodes to reach a free port ([#16773](https://github.com/can1357/oh-my-pi/issues/16773), [#16774](https://github.com/can1357/oh-my-pi/pull/16774) by [@berney](https://github.com/berney))
- Fixed the built-in `ps` reporting an unsupported long option such as `--forest` as `unsupported option '--'`; it now names the option, and every unsupported-option error says that a system `ps`, if installed, may support more options when run by its full path ([#17018](https://github.com/can1357/oh-my-pi/pull/17018) by [@sjawhar](https://github.com/sjawhar))
- Fixed `kill %N` on a backgrounded compound command (such as `(while :; do :; done) &`) in a persistent shell session: the job was reported done but the in-process loop kept spinning until the process exited; it now stops at the next interpreter check ([#16937](https://github.com/can1357/oh-my-pi/pull/16937) by [@holny](https://github.com/holny))
- Fixed `sort -t=` (and clusters such as `-nrt=`) failing with "separator must be exactly one character long"; an attached `=` now selects `=` as the field separator, as in GNU sort, and `-t=X` such as `-t==` is rejected as two characters ([#17017](https://github.com/can1357/oh-my-pi/pull/17017) by [@sjawhar](https://github.com/sjawhar))
- Fixed macOS `press()` on a control with no press action, such as a button on a Chrome page, failing without saying what to do; the error now tells you to `click()` it instead ([#16916](https://github.com/can1357/oh-my-pi/pull/16916) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `kill %N` on a backgrounded compound command (such as `(while :; do :; done) &`) in a persistent shell session: the job was reported done but the in-process loop kept spinning until the process exited; it now stops at the next interpreter check ([#16937](https://github.com/can1357/oh-my-pi/pull/16937) by [@holny](https://github.com/holny))
- Fixed `sort -t=` (and clusters such as `-nrt=`) failing with "separator must be exactly one character long"; an attached `=` now selects `=` as the field separator, as in GNU sort, and `-t=X` such as `-t==` is rejected as two characters ([#17017](https://github.com/can1357/oh-my-pi/pull/17017) by [@sjawhar](https://github.com/sjawhar))

### Changed

- Faster native grep on minified and long lines ([#17016](https://github.com/can1357/oh-my-pi/pull/17016) by [@GTanger](https://github.com/GTanger))
- Faster native ANSI text wrapping on long lines with many words ([#16927](https://github.com/can1357/oh-my-pi/pull/16927) by [@GTanger](https://github.com/GTanger))
- Faster native memory reranking when selecting many results ([#16921](https://github.com/can1357/oh-my-pi/pull/16921) by [@GTanger](https://github.com/GTanger))
- Faster structural code summaries on large files ([#16993](https://github.com/can1357/oh-my-pi/pull/16993) by [@GTanger](https://github.com/GTanger))
- Faster native edit diff formatting and fuzzy line matching on large files ([#16926](https://github.com/can1357/oh-my-pi/pull/16926) by [@GTanger](https://github.com/GTanger))
- Reduced native word-diff allocation overhead when joining tokens and deduplicating boundary whitespace ([#16922](https://github.com/can1357/oh-my-pi/pull/16922) by [@GTanger](https://github.com/GTanger))

### Fixed

- Fixed macOS `ax()` and `find()` leaving a text field with no label of its own, such as Reminders' Add Date and Add Location fields, unnamed; such a field is now named by its placeholder ([#16915](https://github.com/can1357/oh-my-pi/pull/16915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed minimized `ruff check --output-format full` output counting code-frame lines with function calls, such as `14 | assert skill.read() == …`, as diagnostics and files, which inflated the `N diagnostics in M files` summary ([#16837](https://github.com/can1357/oh-my-pi/issues/16837))
- Fixed omp crashing with a stack overflow when an edit's path did not resolve to an existing file and the workspace search for it reached a deeply nested directory tree; directory walks no longer use a stack frame per nesting level ([#16857](https://github.com/can1357/oh-my-pi/issues/16857))
- Fixed the built-in `ps` crashing the shell on a non-ASCII character in an option cluster such as `ps -é`; it now reports `unsupported option '-é'` like any other unknown option ([#17019](https://github.com/can1357/oh-my-pi/pull/17019) by [@sjawhar](https://github.com/sjawhar))
- Fixed macOS `ax()` and `find()` leaving a text field with no label of its own, such as Reminders' Add Date and Add Location fields, unnamed; such a field is now named by its placeholder ([#16915](https://github.com/can1357/oh-my-pi/pull/16915) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed computer use on macOS being unable to finish renaming a file in Finder: keys, `el.type` and `el.press` sent to the rename field were refused, and so were clicks in its window while Finder was your frontmost app ([#16910](https://github.com/can1357/oh-my-pi/pull/16910) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a UTF-8 char-boundary panic when parsing `stateDiagram-v2` lines where `>` follows a multibyte character ([#16749](https://github.com/can1357/oh-my-pi/pull/16749) by [@berney](https://github.com/berney))
- Fixed the bash tool's `rg` and `fd` on macOS and Linux finding nothing under a path that is a symlink to a directory, such as `/tmp` or `/etc` on macOS or a symlinked skill folder; like ripgrep and fd, they now search the folder the link points to ([#16598](https://github.com/can1357/oh-my-pi/pull/16598) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed minimized `git diff`, `git show` and `diff -u` output dropping a hunk's changes and listing a made-up file when a changed line starts with `-- ` or `++ ` (SQL comments, Markdown `---` rules) ([#16588](https://github.com/can1357/oh-my-pi/pull/16588) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the bash tool's minimizer summarizing word diffs (`git diff --word-diff`, `--color-words`, `--word-diff-regex`), which carry no per-line `+`/`-` markers; word-diff patches are now passed through unsummarized ([#16588](https://github.com/can1357/oh-my-pi/pull/16588) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Mermaid flowcharts drawing two edges between the same pair of nodes as one line, with their labels written over each other; each edge now gets its own route, line style, arrowhead and label ([#16731](https://github.com/can1357/oh-my-pi/issues/16731))
- Fixed `renderMermaidAscii` starting an edge one cell away from its node's side when a labeled sibling edge leaves the same node from another side ([#16730](https://github.com/can1357/oh-my-pi/issues/16730))
- Fixed Mermaid flowchart parsing swallowing leading dashes of spaceless arrows (`A-->B`, `B-.->C`, `C:::cls-->D`) into the preceding node ID or class name ([#16750](https://github.com/can1357/oh-my-pi/pull/16750) by [@berney](https://github.com/berney))
- Fixed macOS `press()` on a control with no press action, such as a button on a Chrome page, failing without saying what to do; the error now tells you to `click()` it instead ([#16916](https://github.com/can1357/oh-my-pi/pull/16916) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `openApplication("Contacts")` and `openApplication("Messages")` failing as ambiguous because a helper of the app (an agent app or a running app extension) has the same name; a name shared only with such helpers now opens the app ([#16911](https://github.com/can1357/oh-my-pi/pull/16911) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a macOS background right or middle double click pressing again after you clicked or typed in its app between its presses; it now stops there with `UserIntervened`, as a left click does ([#16770](https://github.com/can1357/oh-my-pi/pull/16770) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background `axType`, `axKeyChord` and `axClick` sending input into an app you switched to while it was busy answering the element's window or bounds lookup; they now read your front app first and refuse with `UserIntervened`, as window input does. The refusal for an element that does not take focus now says no keys were sent, since the focus request reached the app ([#16769](https://github.com/can1357/oh-my-pi/pull/16769) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the shell output minimizer cutting short `git diff`, `git show`, `diff`, `jq` and `ssh` output that fits in 16 KB: it now arrives whole, and the patch summary, the 40-line `jq` cap and the remote head/tail cut apply only to larger output ([#16589](https://github.com/can1357/oh-my-pi/pull/16589) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.5] - 2026-10-21

### Fixed

- Fixed a macOS background action leaving its target in front of your app after you clicked another of your windows, when placing the click took longer than the click itself ([#16217](https://github.com/can1357/oh-my-pi/pull/16217))

## [18.12.4] - 2026-10-20

### Changed

- Reduced native Git diff allocation overhead ([#16349](https://github.com/can1357/oh-my-pi/pull/16349) by [@kyle-elliott](https://github.com/kyle-elliott))
- Reduced native memory-reranking allocations when candidate text contains repeated words ([#16348](https://github.com/can1357/oh-my-pi/pull/16348) by [@kyle-elliott](https://github.com/kyle-elliott))
- Reduced allocation overhead when collecting directory grep results, including paginated searches ([#16226](https://github.com/can1357/oh-my-pi/pull/16226) by [@kyle-elliott](https://github.com/kyle-elliott))
- Token counting for OpenAI, Qwen, DeepSeek, Kimi, GLM and Jev models is 11-30% faster on English text, code and Markdown ([#16399](https://github.com/can1357/oh-my-pi/pull/16399) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed `index.d.ts` drifting from the generated bindings, so building the natives no longer leaves the checkout modified ([#16306](https://github.com/can1357/oh-my-pi/pull/16306) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `cargo test` writing crash reports from panicking Rust tests into your real `~/.omp/logs`: they now go to a per-user `pi-natives-test-logs-<uid>/` under the OS temp dir ([#16386](https://github.com/can1357/oh-my-pi/pull/16386) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the bash tool's `rm -rf` reporting `No such file or directory` for entries another process removed first and leaving the parent directories behind; under `-f` an entry already gone now counts as removed, as in GNU rm ([#16433](https://github.com/can1357/oh-my-pi/pull/16433) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the bash tool's `rg -c` and `rg --count-matches` printing `path:0` for every file without a match; zero counts are now printed only with `--include-zero`, as in ripgrep ([#16432](https://github.com/can1357/oh-my-pi/pull/16432) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `ln -s local://… <path>` in the bash tool creating a host symlink that holds the URL text, which nothing can follow; a symlink on the host to a file-backed URL now stores the file it stands for ([#16428](https://github.com/can1357/oh-my-pi/pull/16428) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background input leaving the target app in front of yours when it came forward just as you clicked another window of your app; your app comes back with the window you clicked ([#16217](https://github.com/can1357/oh-my-pi/pull/16217) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed omp sessions on macOS adding a terminal icon to the Dock after the `computer` tool listed displays ([#13455](https://github.com/can1357/oh-my-pi/pull/13455) by [@VelizarSeleznev](https://github.com/VelizarSeleznev))

## [18.12.3] - 2026-10-19

### Added

- Added a `hiddenContent` option to `htmlToMarkdown`: `"drop"` (default) omits hidden content, `"reachable"` keeps content the page can reveal such as collapsed sections and inactive tab panels, and `"all"` also keeps `<template>` and `<noscript>` content; other values throw ([#16246](https://github.com/can1357/oh-my-pi/issues/16246))
- Added `normalizePtyDimensions(cols, rows)` to size screen emulators with the same effective dimensions as native PTY sessions ([#16192](https://github.com/can1357/oh-my-pi/pull/16192) by [@C-W-Z](https://github.com/C-W-Z))
- Added `LineMatcher`, a native multi-pattern line matcher: `matchLines` returns a batch's matches column-wise as typed arrays (line, pattern, and the UTF-16 span of each named group in `groupNames()` order)
- Added `PipeStreams` and the `streams` option of `Shell.run`: every pipe the run opens keeps a readable copy of its newest megabyte, so a stage's output stays visible while a later stage (`| tail`) holds it back

### Fixed

- Fixed the output minimizer altering what `ssh` commands print in the bash tool: remote lines were cut to 120 characters and blank lines dropped; ssh's own login and connection notices are still stripped ([#16314](https://github.com/can1357/oh-my-pi/pull/16314) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed X11 background shortcuts and typing reporting `Cancelled` when you stopped them right after the last key went down: the key releases now always go out and the call succeeds ([#16235](https://github.com/can1357/oh-my-pi/pull/16235) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `wrapTextWithAnsi` leaving rows half-empty in Chinese and Japanese text: CJK runs now break between characters to fill each row, closing punctuation such as `，。！」` never starts a row, and opening brackets never end one ([#16219](https://github.com/can1357/oh-my-pi/issues/16219))
- Fixed a cancelled or timed-out macOS `computer` call finishing its lookup of a sheet, popover or menu window, up to 5,000 accessibility elements, before it stopped and let the next request run ([#16233](https://github.com/can1357/oh-my-pi/pull/16233) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.2] - 2026-10-18

### Added

- Added a `refuseMenu` option to `click`, `drag` and `holdMouse`: a macOS background left click on a menu button or popup button, or a drag or hold starting on one, throws `BackgroundUnavailable` before anything is sent ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Added a `returnFocus` option for window input with `takeover`: on macOS the takeover hands focus back to your app even if you clicked meanwhile, and only a third app you switched to keeps focus ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Added `DesktopSession.axSelectText` (macOS) to select text in an accessibility element's value by UTF-16 range, refusing missing or ambiguous matches and returning the selection read back ([#15175](https://github.com/can1357/oh-my-pi/pull/15175) by [@will-bogusz](https://github.com/will-bogusz))
- Added a `menu` item path to `click` options and `axPerform`: a macOS click or action that opens a menu chooses that item, submenus included, and leaves no menu open ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- Added `DesktopSession.axType` and `axKeyChord`, which type into or press keys in one accessibility element; on macOS a field that does not report keyboard focus gets nothing and the error names what has focus; on Windows background input goes straight to the element's own control window and refuses a windowless element ([#15563](https://github.com/can1357/oh-my-pi/pull/15563) by [@will-bogusz](https://github.com/will-bogusz))
- Added `DesktopSession.escapeStops` and `desktopEscapeStops(key)`, counting takeover input you stopped with physical Escape on macOS, Windows and X11, apart from host cancels ([#15564](https://github.com/can1357/oh-my-pi/pull/15564) by [@will-bogusz](https://github.com/will-bogusz))
- Added `UserIntervened` on macOS: keys and clicks stop at your first key or click in the app they go to, and input to an app you used since it was last read waits up to 5 s for you to pause, then fails without sending (needs Input Monitoring) ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Reduced Mermaid XY-chart rendering overhead while preserving chart colors and layout ([#16214](https://github.com/can1357/oh-my-pi/pull/16214) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Reading recent commit subjects in a long Git history now reads only the commits requested instead of walking the whole history ([#16210](https://github.com/can1357/oh-my-pi/pull/16210) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Improved AST search and edit performance in directories containing many unsupported files ([#16213](https://github.com/can1357/oh-my-pi/pull/16213) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Faster numbered source formatting for hashline reads ([#16211](https://github.com/can1357/oh-my-pi/pull/16211) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Improved word-diff performance for inline change highlighting ([#16212](https://github.com/can1357/oh-my-pi/pull/16212) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Window input calls, element `axClick`, `axType` and `axKeyChord` included, resolve to a `DesktopFocusReturn` (`handedBack`, `previousPid`, `frontPid`) when a macOS takeover ran, and to `null` otherwise ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- `BackgroundUnavailable` and partial-delivery errors no longer tell the caller to retry with `takeover:true`; they say whether any input was sent ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Reduced allocation overhead for uncached, result-limited file searches in large directory trees ([#16115](https://github.com/can1357/oh-my-pi/pull/16115) by [@kyle-elliott](https://github.com/kyle-elliott)).
- Desktop window input with `takeover` omitted is now background on every platform even while task control is held; only `takeover: true` selects foreground delivery ([#15173](https://github.com/can1357/oh-my-pi/pull/15173) by [@will-bogusz](https://github.com/will-bogusz))
- Computer use's physical Escape stop now watches the keyboard only during takeover input (`takeover: true`, held control, desktop-level input, raises); without held control, an Escape the user presses in their own app no longer cancels background window input, which the host interrupt still stops ([#15176](https://github.com/can1357/oh-my-pi/pull/15176) by [@will-bogusz](https://github.com/will-bogusz))
- macOS background keys, typing, left clicks and menu commands now refuse with `BackgroundUnavailable` when aimed at a non-key window of the app you are using, or once you have come to the target app, instead of moving your typing there; keys sent while another window of the target app becomes key stop with `InputFailed` ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- macOS `win.menu.items` now makes the window key within its app before reading, so it takes the input lock and throws `InputBusy` while another operation holds it ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- macOS background drags and holds on sliders, scroll bars, splitters and steppers, modified clicks, right-clicks, Electron scrolls and Tk 8.5 clicks now run without bringing the app forward; drags that could pick up files or text still throw `BackgroundUnavailable` ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed macOS `UserIntervened` missing your input during element writes (`axSelectText`, `setValue`, native-field typing, AX actions and popups), a reused Open/Save panel process id counting another app's input, and an event tap started during exit staying live ([#15562](https://github.com/can1357/oh-my-pi/pull/15562))
- Fixed macOS remote-screen `press`/`holdKeys` landing in a Screen Sharing window you brought forward during the layout read, iPhone Mirroring dropping a press right after a release, and a modifier two characters need being pressed twice ([#15193](https://github.com/can1357/oh-my-pi/pull/15193))
- Fixed the macOS focus guard missing switches while a click hit-test stalled and missing an app the action brought forward 200–500 ms after its last send; background actions now keep guarding for that window before returning ([#15195](https://github.com/can1357/oh-my-pi/pull/15195))
- Fixed macOS key rerouting sending your keys to the app you had left after you switched to a third app, letting a menu that still held the keyboard from an earlier action take your keys, and dropping a theft when key focus could not be read ([#16140](https://github.com/can1357/oh-my-pi/pull/16140))
- Fixed macOS keys and mouse buttons staying down when omp is killed or its native input code panics mid-gesture; a key or button you are physically holding is left for you to release ([#15192](https://github.com/can1357/oh-my-pi/pull/15192) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS and X11 background input throwing `BackgroundUnavailable` ("nothing was sent") after part of the call was already sent; it now throws `InputFailed`, and on macOS a call stopped because you came to the target app throws `UserIntervened` ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS takeover `InputFailed` naming only the target window when another held focus; it now names the app's focused window, such as an alert or sheet, or the app that stayed in front ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a macOS `takeover: true` click or key that opened a document or closed a sheet or panel leaving its app in front for good; focus now returns to your app unless you clicked or pressed a shortcut during the takeover ([#15191](https://github.com/can1357/oh-my-pi/pull/15191) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the in-process `cksum --check` panicking on a tagged checksum line that starts with `(` (for example `(file)= <hash>`) instead of reporting it as an invalid checksum line ([#16142](https://github.com/can1357/oh-my-pi/pull/16142) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed `grep --path-separator` leaving `\` separators untouched in printed paths on Windows, so displayed paths no longer mix `\` with the configured separator ([#16143](https://github.com/can1357/oh-my-pi/pull/16143) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed macOS computer use reporting a working physical Escape stop (`globalEscape: true`) when Input Monitoring was turned off and the stop could not see keys; `inputPermission` now reports event-posting access, and permission errors name the terminal or IDE to grant ([#15157](https://github.com/can1357/oh-my-pi/pull/15157) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a persistent `Shell` session discarding its variables, functions, and options when a command ran `exit` or stopped under `set -e`; those now end only the command, and only a failed run resets the session ([#16153](https://github.com/can1357/oh-my-pi/pull/16153) by [@alphastorm](https://github.com/alphastorm))
- Fixed a macOS element-ref `StaleRef` giving no lead when the app destroyed the element and put an identical one in its place: the error now names the one element of the window with the fields the ref was read with, registered as a new ref, and sends nothing to it ([#15574](https://github.com/can1357/oh-my-pi/pull/15574) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS takeover input sending the user back to their previous app when they clicked in the takeover target as the input ended, and keeping the target in front for good when they merely kept typing while takeover held it: a click, a shortcut (any key with Command or Control, such as Command-Tab or Control-Up, a function key or a Globe shortcut), or a switch to another app now leaves the front app to the user, and macOS refuses the hand-back if one came after the takeover's own input; plain typing alone no longer does, once Input Monitoring lets omp tell it apart ([#15176](https://github.com/can1357/oh-my-pi/pull/15176) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background input taking keyboard focus from your app, which then dropped pastes and shortcuts until clicked again, and the focus guard sending your app back to the front just after you picked the target yourself ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background input doing nothing or landing in the wrong place for Chrome pages, apps with several windows, Finder, sheets, popovers, inline editors such as Finder's rename field, and system Open/Save panels; keys for a window behind its own focused sheet now throw `InvalidTarget` naming the sheet ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed TextEdit and Script Editor freezing after a background ⌘S, and background shortcuts reporting success when the app stopped answering; they now throw `InputFailed` saying the outcome is unknown ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `win.menu.items` and `win.menu.select` treating commands such as Font Book's File ▸ New Collection as disabled while the app was in the background or had not yet caught up with an edit ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `openApplication` leaving a hidden running app without a window and bringing Notes or Contacts to the front; it now shows the app behind yours and returns its first window ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background and takeover input refusing while your front app showed no window, as Finder does after a click on the desktop ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a macOS background AX action that failed yet brought its app forward, such as `AXOpen` in Chrome's Open panel, leaving that app in front of yours ([#15184](https://github.com/can1357/oh-my-pi/pull/15184) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background right-clicks, menu button presses and popup `setValue` leaving a menu open in the target app, which took your keyboard; the menu now closes, and a right-click or press that opened one throws `InputFailed` ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a macOS `menu` path or background `press()` on a popup in an Open or Save panel, such as Automator's Where: popup, failing to find its menu ([#15185](https://github.com/can1357/oh-my-pi/pull/15185) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed your typing landing in the macOS app a background action targets when that app brings itself to the front while you type ([#15195](https://github.com/can1357/oh-my-pi/pull/15195) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS background input sending you back to your previous app after you opened the target app from Spotlight during the action ([#15195](https://github.com/can1357/oh-my-pi/pull/15195) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed an app that a macOS background action opens something in, such as TextEdit after a background ⌘O in Finder, staying in front of your app; it is sent back like the target ([#15195](https://github.com/can1357/oh-my-pi/pull/15195) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a key you typed on macOS reaching your app twice or more when a process holding a computer-use event tap exited; `closeDesktopEventTaps()` closes them first ([#15562](https://github.com/can1357/oh-my-pi/pull/15562) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS typing into Screen Sharing and iPhone Mirroring arriving as the wrong characters: it now presses your keyboard layout's keys, types unmodified text in the background and stops while you hold a modifier or Caps Lock is on, and iPhone Mirroring taps and scrolls land where aimed ([#15193](https://github.com/can1357/oh-my-pi/pull/15193) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed your keystrokes landing in the app a macOS background action targets, or vanishing into a menu it opened, when it takes the keyboard mid-action; they now reach your app ([#16140](https://github.com/can1357/oh-my-pi/pull/16140) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed computer use input that had already gone out, such as typed text, a shortcut or a click, reporting `Cancelled` when you stopped it moments later; the stop now ends the next call instead ([#16202](https://github.com/can1357/oh-my-pi/pull/16202) by [@will-bogusz](https://github.com/will-bogusz))

## [18.12.1] - 2026-10-17

### Fixed

- Fixed native memory growing without bound, and eventually crashing the process, when files in a downloaded (WASM) grammar language such as C# were parsed repeatedly ([#16067](https://github.com/can1357/oh-my-pi/issues/16067))

## [18.12.0] - 2026-10-17

### Breaking Changes

- `encodeSixel` and `encodeSixelAsync` now require a fourth terminal-background RGB argument packed as `0xRRGGBB` ([#15891](https://github.com/can1357/oh-my-pi/pull/15891) by [@Bouska](https://github.com/Bouska)).

### Fixed

- Fixed Windows file-lock contention returning permission errors when an existing lease allows synchronization but not full mutex access ([#15930](https://github.com/can1357/oh-my-pi/pull/15930) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed SIXEL images dropping translucent details or showing dark, discolored edges when resized, while preserving fully transparent pixels ([#15891](https://github.com/can1357/oh-my-pi/pull/15891) by [@Bouska](https://github.com/Bouska)).

## [18.11.3] - 2026-10-16

### Changed

- Changed `encodeSixel` and `encodeSixelAsync` to drop a partial last 6-pixel band, so an image never extends below the requested height and the caller no longer has to shrink it to a multiple of 6 ([#16007](https://github.com/can1357/oh-my-pi/issues/16007))

## [18.11.2] - 2026-10-16

### Added

- Added `parseCodeStatus` to check code syntax and its resolved language without generating a summary ([#15904](https://github.com/can1357/oh-my-pi/pull/15904) by [@iliaal](https://github.com/iliaal)).
- Added `DesktopSession.holdDisplayUntilReleased()` and `releaseDisplayAwake()` to keep the display awake until the caller releases it, rather than for 5 minutes after the last request ([#15762](https://github.com/can1357/oh-my-pi/pull/15762) by [@will-bogusz](https://github.com/will-bogusz))

### Changed

- Reduced idle memory on GNU/Linux: once native work has been quiet for 5 seconds, freed native heap pages are returned to the OS without evicting caches ([#15905](https://github.com/can1357/oh-my-pi/pull/15905) by [@iliaal](https://github.com/iliaal))
- Reduced memory held by cached code-structure parses: the cache now caps estimated syntax-tree memory instead of source size, keeps only a file's current and previous parse, and reparses edited files incrementally ([#15886](https://github.com/can1357/oh-my-pi/pull/15886) by [@H4vC](https://github.com/H4vC))
- Changed `warmBlockParse` to skip files over 2 MiB (was 4 MiB), the size above which a typical parse no longer fits the cache ([#15886](https://github.com/can1357/oh-my-pi/pull/15886) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `listWorkspace({ reportDirectoryErrors: true, maxDepth: 0 })` returning an empty result for an unreadable root instead of failing the scan ([#15789](https://github.com/can1357/oh-my-pi/pull/15789))
- Minimized cargo output now keeps one "Blocking waiting for file lock on …" line, so a build stuck behind another cargo process says why ([#14631](https://github.com/can1357/oh-my-pi/pull/14631) by [@jorgoose](https://github.com/jorgoose))
- Fixed `grep` ignoring `maxCountPerFile` when the path is a single file, and single-file count mode stopping at the `maxCount` content cap ([#14162](https://github.com/can1357/oh-my-pi/issues/14162), [#14327](https://github.com/can1357/oh-my-pi/pull/14327) by [@F0Rextasy](https://github.com/F0Rextasy))

## [18.11.1] - 2026-10-15

### Added

- Added `listWorkspace({ reportDirectoryErrors })`: an unreadable root fails the scan and unreadable subdirectories are returned in `unreadableDirectories` instead of being silently skipped ([#15769](https://github.com/can1357/oh-my-pi/issues/15769)).

### Fixed

- Fixed unnecessary worker scheduling overhead in `read` loops over regular files ([#15504](https://github.com/can1357/oh-my-pi/pull/15504) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed `astGrep` and `astEdit` missing parse errors when Tree-sitter recovered by inserting a missing token, so edits could rewrite files that do not parse; such files are now reported and skipped ([#15530](https://github.com/can1357/oh-my-pi/issues/15530), [#15851](https://github.com/can1357/oh-my-pi/pull/15851) by [@glyahh](https://github.com/glyahh))
- Fixed `grep` and `astGrep` `glob` filters skipping the files under a directory the glob matches, so `{src,test}` or `sr?` found nothing; a matched directory now selects every file under it, so `dir/*` also matches files in `dir`'s subdirectories ([#15760](https://github.com/can1357/oh-my-pi/issues/15760))
- Fixed `grep()` and `search()` showing the start of a line wider than `maxColumns`, with no `column`, when the only match was an empty one at the end of the file (`$` or `\z` on a last line without a newline); they now show the end of the line and its column ([#15411](https://github.com/can1357/oh-my-pi/pull/15411) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed embedded-shell `xargs` failing with "Argument list too long" on large input lists instead of splitting them into executable batches ([#15708](https://github.com/can1357/oh-my-pi/pull/15708) by [@mg-mg-mg](https://github.com/mg-mg-mg))
- Fixed applying a submodule pin patch to the worktree failing with "does not exist" for a submodule directory or trying to write the pinned commit as a file; like `git apply`, the submodule's checkout is left untouched, an added pin creates its empty directory, and a removed one deletes only an empty (uninitialized) directory ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `diffText`/`numstat` showing a moved submodule as a delete plus an add instead of Git's 100% rename, and `applyPatch` now applies such rename patches ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `submodulePaths()` following `.gitmodules` paths that are absolute or contain `.`/`..`, which could point outside the repository or loop forever; like Git, such entries are ignored ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed `copyGitObjects` exposing partially copied objects and packs to concurrent Git readers and permanently skipping a file truncated by an interrupted copy; each file is now published atomically ([#15459](https://github.com/can1357/oh-my-pi/pull/15459))
- Fixed embedded-shell `read` in a pipeline stage or async job queueing a second blocking worker while holding its own, which could hang every such read once the bounded blocking pool filled ([#15509](https://github.com/can1357/oh-my-pi/pull/15509))
- Fixed Mermaid labels decoding legacy references such as `&#128;` or `#150;` to invisible C1 controls instead of the browser's `€` and `–` ([#15621](https://github.com/can1357/oh-my-pi/pull/15621))

## [18.11.0] - 2026-10-14

### Fixed

- Fixed macOS `setValue` on native text fields in background apps such as Contacts, Reminders, Calendar, Font Book and System Settings returning success for text the app showed but never stored: it now enters the text the way `win.type` does, and a mismatch names what the field reads ([#15293](https://github.com/can1357/oh-my-pi/pull/15293) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a macOS desktop session keeping the display awake for the rest of the process after a native request hung; the request's timeout or `close()` now releases it ([#15414](https://github.com/can1357/oh-my-pi/pull/15414) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the macOS `computer` tool sometimes reading an empty page on its first read of a Chrome window, and leaving Electron apps it read in screen-reader mode until they quit ([#15604](https://github.com/can1357/oh-my-pi/pull/15604) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `press()` on a scrolled-out row in a Mac Catalyst app reporting success while nothing happened: the element is asked to scroll into view first ([#15607](https://github.com/can1357/oh-my-pi/pull/15607) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed shell builtins on Windows resolving drive-relative paths (`C:`, `C:name`) against the agent process's start directory instead of the shell's working directory, which let `cd /c/Temp/x && rm -rf C:` delete the start directory; `rm` now also refuses a bare drive operand like `.` ([#15511](https://github.com/can1357/oh-my-pi/issues/15511))
- Fixed `renderMermaidAscii` printing character references in labels verbatim: HTML entities (`&lt;`, `&amp;`, `&#60;`, `&#x3C;`) and Mermaid entity codes (`#quot;`, `#60;`) now render as the characters they name ([#15619](https://github.com/can1357/oh-my-pi/issues/15619))
- Fixed `read` and `while read` hanging on process-substitution input ([#15501](https://github.com/can1357/oh-my-pi/issues/15501))
- Fixed standalone binaries extracting unused native addon variants on first launch ([#15462](https://github.com/can1357/oh-my-pi/issues/15462))
- Fixed Git diffs failing when staged or committed changes update a submodule pin ([#15457](https://github.com/can1357/oh-my-pi/issues/15457))

## [18.10.4] - 2026-10-13

### Fixed

- Fixed `pwsh` code blocks rendering without PowerShell syntax colors ([#15008](https://github.com/can1357/oh-my-pi/issues/15008)).

## [18.10.2] - 2026-10-12

### Added

- Added in-process `env`, `du`, `chmod`, `fold`, `rmdir`, `od`, `df`, `uptime`, `id`, and `dd` shell builtins matching GNU coreutils 9.x options, output, and exit codes (`chmod` and `id` on Unix only; `dd` is disabled with the destructive set by `PI_DISABLE_UUTILS_DESTRUCTIVE`).
- Added an in-process `nl` shell builtin (ported from uutils coreutils 0.8.0, matching GNU `nl`), with header/body/footer numbering styles including `pBRE` regex styles, logical-page section delimiters, `-l` blank-line grouping, and `ln`/`rn`/`rz` number formats.

## [18.10.0] - 2026-10-12

### Added

- Added `IpcServer`, `IpcConnection`, and `ipcEndpoint`: a local IPC transport over Unix sockets and Windows named pipes with owner-only access, single-instance binding, stale-endpoint takeover, and newline framing.

### Changed

- Optimized transport performance with task-local write coalescing and batch-based newline processing

## [18.9.2] - 2026-10-11

### Fixed

- Fixed stalls when highlighting Markdown tool previews containing many inline spans or backslash escapes.

## [18.9.1] - 2026-10-11

### Fixed

- Fixed executable scripts without a `#!` line failing with "Exec format error" in the embedded shell ([#15271](https://github.com/can1357/oh-my-pi/pull/15271) by [@iliaal](https://github.com/iliaal)).

## [18.9.0] - 2026-10-11

### Added

- Added `applyBinaryPatch(oldPath, patchPath, outPath)` for applying HDiffPatch single-stream delta patches, including zstd-compressed patches, to files.
- macOS desktop sessions now keep the display awake while in use and expose screen-lock and display-sleep state through capabilities, `screenState`, and screen captures.

### Changed

- Improved Linux embedded-shell startup performance for external commands.
- Improved macOS computer-use performance, including faster screenshots and accessibility queries, with better handling of large numbers of off-screen windows.
- Updated `grep()` and `search()` to truncate matching lines around the first match when they exceed `maxColumns`, mark truncated sides with `...`, and report the match's character column.

### Fixed

- Fixed macOS accessibility and window-management operations requiring Screen Recording permission; only screenshots and display listing now require that permission, and window listing includes windows beyond the frontmost 48. Window titles from other applications remain unavailable without Screen Recording permission.
- Fixed macOS menu inspection and selection for menus containing items whose titles cannot be read; those items are now skipped safely.
- Fixed syntax highlighting and language detection for several languages, including TOML, PowerShell, SCSS, Less, Vim script, GraphQL, Protobuf, Terraform/HCL, Dockerfile, CMake, INI, gitignore, Kotlin, Swift, Elixir, Sass, Python f-strings, Julia interpolations, and Elixir interpolations.

## [18.8.8] - 2026-10-10

### Changed

- Reduced macOS accessibility-tree latency for `ax()` without changing its text output: each element's children are read once, and its bounds, which the tree never shows, are no longer read ([#15159](https://github.com/can1357/oh-my-pi/pull/15159) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed macOS computer use reporting `AxFailed` instead of `StaleRef` for a ref whose element the app had removed ([#15156](https://github.com/can1357/oh-my-pi/pull/15156) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `el.press()` and `el.perform()` reporting `AxFailed` when the app did not answer in time, such as a press that opens a modal dialog; they now report `AxUnconfirmed` ([#15156](https://github.com/can1357/oh-my-pi/pull/15156) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.7] - 2026-10-09

### Added

- Added `wasmGrammarFor` for tree-sitter grammars loaded as WebAssembly on demand from `<natives dir>/grammars`, and `missingGrammars` on `astGrep`/`astEdit` results naming languages skipped because their grammar is not installed.

### Changed

- Reduced syntax-highlighting startup work by bundling the complete precompiled grammar set ([#14104](https://github.com/can1357/oh-my-pi/pull/14104) by [@iliaal](https://github.com/iliaal)).
- Changed standalone binaries to embed each native addon as its own deterministic zstd frame instead of a timestamped gzip tarball, making binaries smaller.
- Updated the shell's built-in `jq` to jaq 3.1.1, which `jq --version` now reports ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed the built-in `jq` erroring where jq returns `null` (`.a.b` over `{}`, `.[0]` over `null`) and lacking `IN`, `input_filename`, `input_line_number` and `--unbuffered` ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq` reading each file operand separately: `-s` now slurps them into one array and `input` reads on into the next file, as in jq ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq` stopping at the first input that fails and rejecting `"021"` and `"+1"` in `tonumber`, where jq does neither; a run that reported a failing input is never shortened by the output minimizer, even when it exits 0 ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq`'s `halt_error` printing its message to stdout; like jq, it now goes to stderr ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Shrank the native addon by about 77 MB: only 17 common tree-sitter grammars are linked in, and the other 39 languages load WebAssembly grammars from the grammar directory, treated as unsupported until installed.

## [18.8.4] - 2026-10-08

### Fixed

- Fixed long output from a failing `jq` command hiding its error message: the output minimizer now shortens `jq` output only when the command succeeded ([#14657](https://github.com/can1357/oh-my-pi/pull/14657) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.1] - 2026-10-07

### Added

- Added the `PI_NATIVES_DIR` configuration option to control where compiled native addons are extracted. The version-specific subdirectory remains appended, allowing separate `HOME` environments to share the same native addon copy without sharing other data.

### Fixed

- Fixed background shell builtins and other in-process commands so they terminate when their subshell exits and can be stopped with `kill %N`, matching the behavior of external commands.

## [18.7.0] - 2026-10-06

### Breaking Changes

- Renamed the `linux-all` Bazel target (`//:natives-linux-all`) to `all` (`//:natives-all`); the renamed target now includes Darwin addons.
- Removed the `gen:native` and `gen:native:reset` scripts. Standalone binary builds now embed the native addon archive and manifest instead of writing them to `native/`.

### Added

- Enhanced `rasterizeSvg` with optional scaling and terminal-cell padding, allowing SVGs to render larger while preserving 1:1 display in terminals.
- Added `OMP_NATIVE_FEATURES` for passing extra Cargo features to local native addon builds; Bazel builds ignore this setting.
- Added support for cross-compiling macOS native addons from Linux hosts.

### Changed

- macOS addon release stamping now works on any host by refreshing the addon's ad-hoc signature automatically.

### Fixed

- Fixed `tail` failing to print files, or omitting their first 64 KiB, when file sizes were exact multiples of 64 KiB.
- Fixed `tail` printing nothing, or dropping lines from the file's first 64 KiB, when the file size is an exact multiple of 64 KiB ([#14264](https://github.com/can1357/oh-my-pi/pull/14264) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed native `sed` and `jq` killing the host process with SIGBUS when an input file is truncated while they read it ([#14613](https://github.com/can1357/oh-my-pi/issues/14613))
- Fixed `tail -f` piped into a command that exits early (such as `head -n 1` or `grep -m1`) never stopping on macOS ([#14614](https://github.com/can1357/oh-my-pi/issues/14614))
- Native `sort -u` keeps punctuation-distinct paths under UTF-8 locales instead of silently dropping records ([#14606](https://github.com/can1357/oh-my-pi/issues/14606)).

## [18.6.3] - 2026-10-06

### Breaking Changes

- `isoResolve` now returns a Promise and runs off the JavaScript thread; a backend found available is not re-probed ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))

### Added

- Added `encodeSixelAsync` and `decodeSixelToPngAsync`, which encode and decode SIXEL off the JavaScript thread ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- Added `warmBlockParse`, which parses a file for block context off the JavaScript thread so later block-context lookups answer from the cache; files over 4 MiB, which the cache does not keep, are skipped ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- Added native screenshot region capture without replacing the full-frame coordinate reference, native cancellation generations, and cross-process input/focus ownership.
- Added operation-scoped physical Escape cancellation on macOS.
- Added native application discovery/launch, background menus, combined image/AX observations, display targets, bounded held input, task control ownership, and macOS Space movement.

### Changed

- Replaced per-screenshot macOS subprocesses and intermediate PNGs with a persistent ScreenCaptureKit main-loop worker on macOS 14+ and in-process CoreGraphics on macOS 12/13.
- Read macOS window metadata from one coherent Quartz snapshot instead of re-enumerating the desktop for each window property.
- Defaulted desktop capture to the focused window's monitor, retaining explicit all-display and display-ID selection.
- Removed legacy desktop-addon emulation; computer use now requires the current native capture/cancellation API.
- Sped up the embedded shell on command output that is not valid UTF-8: decoding is linear, so commands printing binary data no longer stall (1 MiB took 14 s), and captured output is decoded once ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up edit previews while edit arguments stream: diffs, fuzzy matching and hashline parsing no longer redo or copy all their work for every streamed chunk ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- Sped up `fuzzyFind`: a cached scan is scored in place instead of being copied on every call ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up applying multi-hunk patches and `astEdit` calls with many edits ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Sped up `countTokens` on long runs of one kind of character, such as whitespace or letters ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up builtins that print many lines (`ls`, `find`, `paste`, `diff`, `cmp`, `wc`, `echo`, `ts`), `while read` and `mapfile` loops over files, and `sed` scripts using `N` ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Sped up flowchart and state diagram rendering in `renderMermaidAscii`; a 40-node flowchart renders about 14× faster, with identical output ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `find -type`, `rm -r`, `mkdir -p`, `ls` and `stat`, especially on Windows ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Sped up `sed` scripts that use regular expressions, `printf` output, and `sort -`, which now reads standard input directly instead of copying it to a temporary file ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `cp` and `mv` of directory trees; `mv` within one filesystem no longer walks the moved tree first ([#14524](https://github.com/can1357/oh-my-pi/pull/14524) by [@H4vC](https://github.com/H4vC))
- Staging files or hunks keeps the git index's file stat cache, so the next status check no longer re-reads every tracked file; staging many files rewrites the index once ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- `pidwait` and PTY sessions wait for process exit and cancellation events instead of polling ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Applying a patch to the worktree reads only the files the patch touches ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `listWorkspace`, `fuzzyFind` with followed symlinks, and `fd`; the file-mention scan cache releases expired entries sooner ([#14527](https://github.com/can1357/oh-my-pi/pull/14527) by [@H4vC](https://github.com/H4vC))
- Sped up parsing of large hashline edits ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up copy-on-write task isolation setup on reflink (Linux) and ReFS (Windows) volumes ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))
- `Process.waitForExit()` on a single process waits for the operating system's exit notification instead of polling every 50 ms ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Reduced memory and copying in `renderMermaidAscii`, snapcompact rendering and single-display desktop screenshots ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- `DesktopSession.capabilities` no longer blocks behind a running capture or input operation: while one runs, it answers from the capabilities read by the latest capture or capabilities call; otherwise it reads them live ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- Native OAuth logins are detected as soon as the browser redirects, without polling every 20 ms ([#14531](https://github.com/can1357/oh-my-pi/pull/14531) by [@H4vC](https://github.com/H4vC))
- Reduced the memory used by the local completion model's tokenizer ([#14533](https://github.com/can1357/oh-my-pi/pull/14533) by [@H4vC](https://github.com/H4vC))
- Long lines cut by the lint, gt and system output minimizers now end in `…[+N]`, showing how many characters were dropped ([#14532](https://github.com/can1357/oh-my-pi/pull/14532) by [@H4vC](https://github.com/H4vC))
- Reduced the memory used by tokenizer tables and by counting Claude tokens on long inputs ([#14530](https://github.com/can1357/oh-my-pi/pull/14530) by [@H4vC](https://github.com/H4vC))

### Fixed

- Rejected stale display-layout coordinates before pointer input and zoom, and preserved the previous coordinate frame when a capture is canceled.
- Released held input on cancellation and refused competing native mutations before dispatch.
- Fixed `umask` in the embedded shell changing the host process's umask; the mask now belongs to the shell, applies to files created by redirections, builtins such as `touch`, `mkdir` and `cp`, and external commands, and a subshell's `umask` no longer leaks out ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed diff hunk headers sometimes naming a different enclosing function than `git diff` does ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Fixed `enable exec` and `enable suspend` restoring builtins that replace or stop the host process ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `ls -t` and `ls -S` listing entries with equal times or sizes in arbitrary order, and `ls --group-directories-first` scrambling entries within each group; ties now sort by name as in GNU `ls` ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Fixed `rm -r` and `rm -d` on Windows failing on a directory that has the read-only attribute ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Fixed `declare -r` listing only readonly variables that were also traced, and `declare -t` listing every variable ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `sed` regular expressions treating `\b` as a backspace instead of a word boundary ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `mv` between filesystems losing modification times, modes, ownership, subdirectory extended attributes and hard links, failing on sockets, and removing source symlinks when copying an entry failed ([#14524](https://github.com/can1357/oh-my-pi/pull/14524) by [@H4vC](https://github.com/H4vC))
- Fixed `sort` reading standard input again for each repeated `-` operand ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `sort` collating text only on its first run in a session and taking its collation order, decimal point and thousands separator from omp's own locale instead of the shell's `LC_ALL`, `LC_COLLATE`, `LC_NUMERIC` and `LANG`, and `sort --parallel` changing the host's thread pool: `--parallel=N` now limits that sort to N threads and rejects invalid counts as GNU sort does ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed `tac` crashing omp when the file it read was truncated at the same time ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed `tail -f` piped into a command that exits early (such as `grep -m1`) never stopping, including when following provider-backed paths ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed run cancellation on Windows terminating an unrelated older process when the cancelled command reused the process ID of that process's exited parent ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed staging hunks and stashing clearing the index's skip-worktree flags, so files outside a sparse checkout no longer show as deleted afterwards ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed the `psql` output minimizer listing every table row whose first column began with a word like `ERROR` above the table, instead of applying the row limit ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a PTY command hanging forever when its output callback stopped consuming output; the bridge now disconnects after the stall timeout like the shell bridge ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Fixed `Process.args()` on Windows returning an empty list for elevated processes when the caller is not elevated ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Fixed strings passed to native functions sometimes losing their last characters when they ended in non-ASCII text (seen as `highlightCode` dropping the end of long lines) ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `renderMermaidAscii` hanging and running out of memory on an `xychart` axis whose range is finer than floating-point precision ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed copied task isolation trees on Windows turning directory symlinks into file symlinks ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))
- Fixed `getWorkProfile()` attributing async work to the wrong region or dropping it ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `read` and `mapfile` in the embedded shell treating Ctrl-C and Ctrl-D bytes in a file or pipe as an interrupt or end of input (`printf 'a\003b\n' | read -r x` failed, `printf '\004x\n' | mapfile` stored nothing); they are keys only when standard input is a terminal ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `read` storing each byte of UTF-8 input as a separate character (`é` became `Ã©`); `read -n` and `read -N` now count characters instead of bytes, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `read -d` with a multibyte delimiter never matching; it stops at the delimiter's first byte, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `echo -e -E` expanding escapes; the later option wins, as in bash ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `mapfile -O` writing into a readonly array; it now fails before reading any input, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `computer` element refs expiring after two `ax()` reads of a window while the element was still there: an element now keeps its `[ref=eN]` across `ax()` and `find()` reads, even after missing a single snapshot. An element whose role or label changes gets a new ref, and its old ref keeps working until it expires; on Windows, an element that reuses a gone element's `RuntimeId` gets a new ref, and one whose `RuntimeId` cannot be read gets a new ref on every read ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))

## [18.6.2] - 2026-10-04

### Fixed

- Fixed short snapcompact PNGs being emitted below the minimum dimensions accepted by some vision backends ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).

## [18.6.1] - 2026-10-04

### Fixed

- Fixed concurrent searches through host-provided filesystem callbacks so they no longer starve other asynchronous filesystem operations, and ensured canceled searches release promptly.

## [18.5.1] - 2026-10-03

### Fixed

- Fixed macOS computer-use scrolling so takeover and desktop scroll actions move iPhone Mirroring and other pixel-forwarding windows reliably, with smooth mouse-like wheel steps.
- Fixed macOS computer-use value entry for date and time controls, including Calendar date pickers, with support for ISO 8601 dates and date-times and clear validation for unsupported formats.
- Fixed macOS computer-use value entry for popup buttons, allowing options to be selected by title with confirmation and reporting available options when a title is not found.
- Fixed macOS accessibility values for checkboxes, radio buttons, and radio groups so snapshots, attributes, and window information return usable numbers, titles, and referenced element values instead of debug representations.

## [18.5.0] - 2026-10-03

### Fixed

- Fixed Ctrl+V on Windows sometimes pasting text with a few characters replaced by unrelated glyphs (for example `https://` turning into `՞ttp缀難//`); clipboard reads and writes no longer run at the same time ([#14144](https://github.com/can1357/oh-my-pi/pull/14144) by [@H4vC](https://github.com/H4vC))

## [18.4.10] - 2026-10-02

### Fixed

- Fixed the embedded shell sometimes hanging on a pipeline with a stage that stopped (for example with `kill -STOP $$`) before the shell began waiting on it; the pipeline now becomes a stopped job ([#14023](https://github.com/can1357/oh-my-pi/pull/14023) by [@sjawhar](https://github.com/sjawhar))

## [18.4.9] - 2026-10-01

### Added

- Added `readTextFromClipboard()` for reading plain text from the system clipboard without starting a subprocess.
- Added `Shell.pids()` to retrieve the IDs of still-running processes spawned by an in-flight shell command.

## [18.4.7] - 2026-10-01

### Fixed

- Fixed omp 18.4.3 and later crashing with a segmentation fault at startup on Apple silicon Macs running macOS older than 27; Apple Foundation Models support now loads only on macOS 27 and later

## [18.4.5] - 2026-09-30

### Fixed

- Fixed macOS spell checking and Apple word completion adding a duplicate terminal icon to the Dock for every omp session ([#12491](https://github.com/can1357/oh-my-pi/issues/12491))
- Fixed `computer.windows()` on macOS marking every window of the frontmost app as focused. One window is marked now: the app's accessibility focused window, or its frontmost window when Accessibility permission is not granted. With the permission, `computer.focusedWindow()` no longer returns a floating panel such as TextEdit's Fonts panel in front of the document ([#13673](https://github.com/can1357/oh-my-pi/pull/13673) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed non-Latin prompts that quote code in backticks or fences losing most of their prose score, which made the typing predictor's vocabulary refuse to learn them ([#13758](https://github.com/can1357/oh-my-pi/pull/13758) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed `computer.window(...).ax()` leaving out everything inside an unnamed container. On macOS, Reminders, Contacts, Notes and Font Book windows showed only their toolbar and window buttons, and Calendar lost its month grid; Windows and Linux trees now also keep content under unnamed containers such as custom panes, lists and fillers ([#13822](https://github.com/can1357/oh-my-pi/pull/13822) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed Wayland `computer.drag()` sending all waypoints in one burst, preventing HTML5 drag-and-drop targets from receiving `drop` ([#13860](https://github.com/can1357/oh-my-pi/issues/13860)).
- Fixed Wayland computer input staying unavailable after a cancelled RemoteDesktop permission prompt or a disconnected input session ([#13857](https://github.com/can1357/oh-my-pi/issues/13857)).
- Fixed Wayland `win.screenshot()` returning the top-left of the monitor for native Wayland windows whose position AT-SPI cannot report (Discord, Teams, Chromium); it now fails with `CaptureFailed` instead of capturing the wrong region ([#13854](https://github.com/can1357/oh-my-pi/issues/13854)).
- Fixed `computer.focusedElement()` failing with `AxFailed: atspi: null reference` on Linux while a Chromium or Electron app (Spotify, Discord, Steam, …) is running ([#13855](https://github.com/can1357/oh-my-pi/issues/13855)).

## [18.4.4] - 2026-09-29

### Fixed

- Fixed `computer.window(id).ax()` and `find()` failing with `AxFailed` on macOS sheets, popovers and open menus that `computer.windows()` lists, such as TextEdit's Save sheet or a Calendar event popover ([#13659](https://github.com/can1357/oh-my-pi/pull/13659) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed macOS 26 background scrolls moving twice the requested distance; background hovers, scrolls and right or middle clicks are now delivered once ([#13739](https://github.com/can1357/oh-my-pi/pull/13739) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed macOS `takeover` clicks and scrolls failing with `AX action 'AXRaise' failed (AXError(-25205))` on covered windows that do not support `AXRaise`, such as iPhone Mirroring, even when activation brings them forward; a window that stays covered still refuses before any input is sent ([#13737](https://github.com/can1357/oh-my-pi/pull/13737) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed `ps -r` in the in-process `ps` builtin: it now sorts by CPU usage, highest first, as on macOS/BSD, instead of filtering to running processes. Also added `ps -m`, which sorts by memory usage.
- Fixed process states on macOS in the `ps`, `top`, and `pgrep`/`pkill -r` builtins: idle processes showed as running (`R`), which made `ps r` list nearly every process. States now come from each process's threads, as Apple `ps` does.
- Removed the procps-only `l` (multithreaded) STAT flag from `ps` on macOS; Apple `ps` doesn't print it.

## [18.4.3] - 2026-09-28

### Changed

- Lowered the macOS native addons' minimum supported macOS version to 12.0 (previously 15.5)
- Reduced snapshot cost on every hashline read and grep: file-hash tagging no longer builds a normalized copy of the file, and the seen-line prefix regex is compiled once ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Fixed released Darwin arm64 addons omitting Apple Foundation Models support ([#13610](https://github.com/can1357/oh-my-pi/issues/13610)).
- Fixed the edit tool's `replace block`/`delete block` operations in indentation-based languages such as Python extending a statement's block over every following statement in its body when a comment line at a different indentation came right after it ([#13358](https://github.com/can1357/oh-my-pi/pull/13358) by [@jchanghong023](https://github.com/jchanghong023)).

## [18.4.2] - 2026-09-28

### Added

- Added `summarizeCodeAsync` for non-blocking source structure summarization on the libuv thread pool

### Fixed

- Fixed concurrent streaming searches hanging indefinitely or ignoring cancellation while waiting to deliver results to JavaScript.
- Fixed ngram word completion losing learned state between sessions on Windows when saving its snapshot ([#13589](https://github.com/can1357/oh-my-pi/issues/13589)).
- Fixed Windows shell pipelines losing their final output when cancelled or timed out (e.g. `yes x | tail -5`): cancelled runs now get a longer grace period to flush before being aborted ([#13365](https://github.com/can1357/oh-my-pi/pull/13365) by [@jchanghong023](https://github.com/jchanghong023))

## [18.4.1] - 2026-09-28

### Fixed

- Fixed `grep` retaining every matching line until the search finished: the new `onMatches` option streams bounded batches while the search runs, pauses the search while JS catches up, and returns only counts ([#13495](https://github.com/can1357/oh-my-pi/issues/13495))
- Fixed omp crashing at startup on macOS when built from source with `SDKROOT` set (e.g. via Nix) on a host whose Command Line Tools ship the macOS 27 SDK ([#13168](https://github.com/can1357/oh-my-pi/pull/13168) by [@johnrichardrinehart](https://github.com/johnrichardrinehart)).
- Hashline edit rejections for a tag issued for another file now name the path the tag belongs to ([#13464](https://github.com/can1357/oh-my-pi/pull/13464) by [@holny](https://github.com/holny)).
- Fixed the native terminal output pump exiting on temporary nonblocking backpressure ([#13463](https://github.com/can1357/oh-my-pi/pull/13463) by [@hancens1024](https://github.com/hancens1024)).
- Fixed commits failing on Windows when a repository has commit hooks; hooks now run through `git hook run` ([#13366](https://github.com/can1357/oh-my-pi/pull/13366) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed Windows path stats lacking a file identity, which let `rg` search its own redirected output and made `tail -F` report spurious replacements ([#13367](https://github.com/can1357/oh-my-pi/pull/13367) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed the embedded shell running backtick spans inside a quoted heredoc within a double-quoted command substitution ([#13307](https://github.com/can1357/oh-my-pi/issues/13307)).
- Fixed native operations to deliver results completed within their timeout and reject results when an abort signal arrives before settlement ([#13209](https://github.com/can1357/oh-my-pi/pull/13209) by [@Komzpa](https://github.com/Komzpa)).
- Fixed `ulimit` in the embedded shell changing the host process's own resource limits, including from inside `( … )` subshells: limits are now shell state applied only to the external commands the shell spawns ([#13325](https://github.com/can1357/oh-my-pi/issues/13325))

## [18.4.0] - 2026-09-28

### Added

- Added Windows path utilities for converting between long and 8.3 short path spellings without resolving symlinks or junctions. Import them from `@oh-my-pi/pi-natives/path`.

### Fixed

- Fixed the native `xargs` builtin so `-P`/`--max-procs` correctly limits parallel command execution, including GNU-compatible `-P 0` behavior.
- Improved snapcompact rendering performance for stretched shapes on Windows x64, Intel Macs, and Linux CPUs without AVX2, with no visual changes.

## [18.3.5] - 2026-09-27

### Changed

- Improved syntax highlighting to use about 5x less memory and run 3-5x faster by compiling grammars with Oniguruma instead of fancy-regex; highlighted output is unchanged.

### Fixed

- Fixed SmolLM word completion (`spelling.autocomplete: smollm`) being about 25x slower on Windows x64 and Intel Macs; suggestions are unchanged ([#13488](https://github.com/can1357/oh-my-pi/pull/13488) by [@H4vC](https://github.com/H4vC))

## [18.3.4] - 2026-09-27

### Fixed

- Fixed the native addon keeping every `bun test --isolate`/`--parallel` test file's global object and module graph alive, which grew each test worker by ~15 MB per file until the run was OOM-killed.

## [18.3.3] - 2026-09-27

### Added

- Added a `TextPredictor` N-API binding for managing the high-performance ghost-text completion engine.

### Changed

- Updated desktop input-control capabilities to use a unified `takeover` setting, including `takeover: true` for forced foreground pointer interaction.

## [18.3.1] - 2026-09-25

### Added

- Added support for asynchronous file I/O and custom filesystem providers in native shell execution, including resolving arbitrary `scheme://` paths through native operation options.

### Fixed

- Fixed shell access to standard and special file descriptors, including `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, and `/dev/tty`, preventing heredoc commands from hanging the TUI.
- Fixed native operations such as grep, glob, AST, shell, and VCS calls to promptly honor an `AbortSignal` that was already aborted when the operation starts.
- Fixed Windows path formatting in the shell’s `fd` and `find` builtins so POSIX path patterns match correctly.

## [18.3.0] - 2026-09-24

### Added

- Added native bindings for Apple Foundation Models availability checks, text generation, and cancellation.
- Added offline token counting support for TypeSafe Jev 1.13 `state` inputs via `Encoding.Jev` (excluding the request frame).

## [18.2.11] - 2026-09-23

### Changed

- Improved `warmHighlighter()` so it prepares TypeScript, TSX, JavaScript, Bash, Python, Rust, and Markdown highlighting in the background, reducing delays on the first highlight for these languages.

## [18.2.9] - 2026-09-22

### Fixed

- Fixed stale workspace addons failing when first used; the error now identifies the addon and provides the command to rebuild native addons.
- Fixed background bash jobs hanging indefinitely when output forwarding stalls.

## [18.2.7] - 2026-09-21

### Added

- Added `renderMermaidAscii`, a native Mermaid-to-ASCII/Unicode renderer supporting flowcharts, state, sequence, class, ER, and xychart diagrams with color modes, themes, and direction overrides.
- Added a `default` package export condition so CommonJS consumers, including bytecode bundles, can load the native bindings.

### Changed

- Improved Mermaid flowchart rendering to respect dependency order, reduce crossings, align branches, and wrap long labels without truncation.

### Fixed

- Fixed Mermaid rendering issues involving arrowhead alignment and duplicate edge junctions around mixed-width node shapes.
- Fixed sloppy edit grammar compatibility with Codex constrained decoding.

## [18.2.1] - 2026-09-15

### Added

- Added `maxBytes` to `VcsGitRepo.diffText` options: rendering stops and the call rejects with an `OutputTooLarge` VcsError once the patch crosses the cap, so callers can bound the memory a large change set may consume ([#11454](https://github.com/can1357/oh-my-pi/pull/11454) by [@sjawhar](https://github.com/sjawhar)).
- Native addon embedding now rejects stale release binaries before standalone builds can package them ([#11831](https://github.com/can1357/oh-my-pi/issues/11831)).
- Fixed git repository discovery treating an unpopulated `.git` directory (no `HEAD`) as a checkout, which made `/wt` and isolated tasks fail with a raw "No such file or directory (os error 2)" instead of reporting that no Git repository was found. Discovery now skips such entries and keeps walking toward the root, matching `git rev-parse`.
- Added `vcsDiscoverForDisplay` (`repoForDisplay`): like repository discovery, but equal-root jj+git ties prefer Jujutsu for the status line and footer. Git-safe automation must keep using `vcsDiscover` ([#11071](https://github.com/can1357/oh-my-pi/issues/11071), [#11325](https://github.com/can1357/oh-my-pi/pull/11325) by [@boazy](https://github.com/boazy)).
- Shell and PTY command output on Windows now falls back from UTF-8 to the system ANSI code page (e.g. GBK on Chinese locales) instead of emitting replacement characters.

### Changed

- Workspace startup scans skip excluded build directories and retain a bounded set of entries and directory rules.
- Limited newest-file searches use less memory on large directory trees when scan caching is disabled.

### Fixed

- Bounded filesystem scan cache memory and prevented stale scans from repopulating the cache after file changes. ([#11240](https://github.com/can1357/oh-my-pi/pull/11240) by [@iliaal](https://github.com/iliaal))
- Fixed the embedded shell and PTY sessions inheriting `GIT_DIR`, `GIT_WORK_TREE`, and related repo-location overrides from the host process, which made `git` run in a secondary worktree mutate the primary one ([#11082](https://github.com/can1357/oh-my-pi/issues/11082)).
- Added a vendored Astro grammar so `.astro` files highlight the `---` TypeScript frontmatter and `{…}` template expressions instead of falling back to plain HTML ([#11164](https://github.com/can1357/oh-my-pi/pull/11164) by [@byigitt](https://github.com/byigitt)).
- Fixed the TUI sometimes stopping repainting while the agent continued running.
- Fixed native Darwin OAuth helper compilation under sandboxed and custom build environments by respecting `$CC` ([#11869](https://github.com/can1357/oh-my-pi/pull/11869) by [@Malix-Labs](https://github.com/Malix-Labs)).

## [18.1.17] - 2026-09-10

### Fixed

- Fixed Wayland computer-use clicks landing in the wrong place on scaled monitors by mapping captures through the portal's logical monitor geometry ([#11540](https://github.com/can1357/oh-my-pi/issues/11540)).

## [18.1.15] - 2026-09-08

### Fixed

- Fixed C++ language inference excluding CUDA header (`.cuh`) files ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).

## [18.1.9] - 2026-09-04

### Added

- Added native Sixel-to-PNG decoding for terminal graphics returned by shell commands.
- Added transactional native OAuth callback registration with one-shot callback delivery on macOS, Linux desktops, and Windows.

### Fixed

- Fixed native version-control cleanup to respect ignore rules and path boundaries while safely handling symlinks, nested repositories, and submodules.

## [18.1.7] - 2026-09-03

### Added

- Added Windows ARM64 native addon support, including platform-specific npm packages.

## [18.1.6] - 2026-09-03

### Breaking Changes

- Renamed `MacOSPowerAssertion` to `PowerAssertion` and `MacOSPowerAssertionOptions` to `PowerAssertionOptions`; the options and handle shapes are unchanged.

### Added

- Added edit-session and edit-store types and utilities for managing edit states, snapshots, hashline operations, edit modes, edit descriptions, editable notebook text, and inline sloppy regions.
- Added cross-platform sleep inhibition to `PowerAssertion` on Linux and Windows.

### Changed

- `PowerAssertion.start` now reports acquisition failures on Linux and Windows instead of returning a handle that silently does nothing; platforms without an implementation continue to receive a no-op handle.

### Fixed

- Fixed native `git add` so staging an empty file list no longer stages macOS filename-normalization duplicates of tracked paths or files ignored only by a nested `.gitignore`.

## [18.1.5] - 2026-09-03

### Changed

- Updated `worktreeAdd` to support additional worktree creation options, including preserving uncommitted changes.

## [18.1.3] - 2026-09-02

### Fixed

- Fixed `grep` and `sed` treating basic regular expressions as extended ones, which silently matched every line for patterns like `^+` or `s/^\+/` and swapped the meanings of `+` and `\+` ([#10298](https://github.com/can1357/oh-my-pi/pull/10298) by [@mruangutai](https://github.com/mruangutai)).

## [18.1.0] - 2026-09-01

### Fixed

- Fixed TTY output backpressure reporting so pending write progress is accurately reflected during large writes.

## [18.0.11] - 2026-08-29

### Fixed

- Fixed staging and committing files through a reused Git repository handle, ensuring newly staged changes are correctly included in commits even on filesystems with coarse timestamp resolution.

## [18.0.10] - 2026-08-28

### Added

- Added native process replacement support for the CLI’s `/restart` command.
- Added `VcsGitRepo.mergeBase(a, b)` to find the best common ancestor of two Git revisions, returning `null` when the histories are unrelated.

## [18.0.9] - 2026-08-28

### Breaking Changes

- Replaced the Git-specific `watchHead` and `headWatchTarget` API with the backend-neutral `watch` and `VcsRepo.watchTarget` APIs.

### Added

- Added portable repository discovery and read operations through `VcsRepo`, `repo()`, and `require()`, with support for Git and Jujutsu and explicit capability checks for staged and revision diffs.
- Added the `Vcs*` API for repository operations across Git and Jujutsu, including repository discovery, refs and status, diffs, staging, commits, branches, worktrees, patch application, stash, cherry-pick, and CLI-backed push, fetch, and clone operations with cancellation support.

### Fixed

- Fixed Git intent-to-add files so they appear correctly as unstaged additions in `statusPorcelain` and are handled correctly when staging or applying patches.

## [18.0.8] - 2026-08-27

### Fixed

- Large session histories no longer leave macOS Terminal unresponsive during repaint.
- Bounded the interactive PTY reader→JS queue (64 × ≤64 KiB) and forward chunks through a separate `call_async` pump so a fast child plus a stalled JS consumer cannot accumulate unbounded output in-process, without freezing PTY input/resize/kill. After a finite child exit, wait until accepted output reaches `on_chunk`; only a permanently open slave skips that wait. Cancel, timeout, and that stuck-open path abort the pump before `start()` resolves. Same defect class as the non-PTY bash bridge (#4078).

## [18.0.6] - 2026-08-26

### Fixed

- Improved TypeScript and TSX syntax highlighting, including correct handling of type annotations and template literals.

## [18.0.5] - 2026-08-25

### Added

- Added asynchronous, size-bounded SVG-to-PNG rasterization for terminal media previews.
- Added the `DiffStream` API for processing text and byte input incrementally, opening files asynchronously, reporting stable-prefix progress, generating exact unified diffs, and warming syntax grammars asynchronously.

## [18.0.3] - 2026-08-23

### Fixed

- `macOSCheckSpelling` no longer reports the whole checked string as misspelled: automatic language identification returns an orthography result spanning the entire text, which leaked through as a typo range overlapping the real word span (doubling editor text under the undercurl and drifting the cursor).

## [18.0.1] - 2026-08-23

### Fixed

- Native macOS spellchecker now honors all active system dictionaries: misspelling detection uses automatic language identification and completions/guesses/corrections select the per-word language, so non-English text (e.g. Russian) is checked instead of only the shared checker's current language ([#9334](https://github.com/can1357/oh-my-pi/issues/9334)).
- Fixed PTY command cancellation leaking zombie child processes: a race where cancellation after spawn only attempted a single non-blocking reap could miss processes still being reaped by the kernel, and an early heartbeat check that bailed out without killing or reaping the child. On Unix, cancellation now polls for the child briefly and hands any straggler to a detached reaper, so the process is always waited on without an unbounded wait.
- Fixed installed CLIs losing desktop capture when the resolved prebuilt addon still exposes the pre-parity `DesktopSession` ABI. That ABI is now adapted behind the current session contract, legacy error codes are translated, and the adapter ships in the published native core package.

## [18.0.0] - 2026-08-22

### Added

- Added native macOS spellchecker APIs (`macOSAutocorrectWord`, `macOSCheckSpelling`, `macOSCompleteWord`, `macOSSpellingGuesses`, and `macOSSpellCheckerAvailable`) that run asynchronously without blocking the JavaScript thread.
- Added `HighlightStream`, a stateful incremental syntax highlighter that supports chunked highlighting while maintaining parser state.
- Added `TtyWriter`, an off-thread terminal output writer that performs non-blocking writes and tracks backlog metrics for renderer frame skipping.

### Changed

- Word completion now automatically appends a space unless followed by punctuation or whitespace.

## [17.4.1] - 2026-08-21

### Changed

- `bun run build:native` now builds through the local cargo/napi-rs backend by default, with Bazel available as an opt-in via `OMP_NATIVE_BUILD_BACKEND=bazel` or extra Bazel arguments after `--`.

## [17.4.0] - 2026-08-20

### Added

- Added offline `countTokens` support for Anthropic Claude families (`ClaudeV3`, `ClaudeV47`, `ClaudeV5`) via a high-performance native port of `ctok`.
- Added exact offline token counting support for Qwen (3.5+, 3.6+, 3.8), DeepSeek (V3, V4, R1), Kimi (K2, K3), and GLM-5 models alongside rebuilt OpenAI encodings, with optimized zero-allocation string passing from JavaScript.
- Added `nodeChainAt` native API to retrieve innermost-first tree-sitter node chains with grammar kinds and line spans for structural syntax analysis.

### Changed

- Improved shell builtins (`grep`, `rg`, `sed`, `cat`, `head`, `tail`, `jq`, `ls`, etc.) to stream output progressively with destination-aware line buffering for pipes, terminals, and live TUI output, while maintaining block buffering for file writes.
- Updated compound blocks (`{ ...; }`, `(...)`) and shell-function pipeline stages to run concurrently with other pipeline stages, preventing head-of-line blocking and pipe buffer deadlocks.

### Fixed

- Fixed the shell output minimizer dropping failure details from non-TTY `bun test` runs: the `(fail)` line, code frame, `error:` assertion, and stack trace are now kept instead of collapsing a failing run to bare pass/fail counts; unrecognized failing test formats now fall back to head/tail instead of counts-only output.

## [17.3.8] - 2026-08-19

### Changed

- `enclosingBlockBoundaries` and `blockRangeAt` now reuse a parsed tree-sitter tree when the same source and language were parsed before, and skip subtrees whose line span holds no visible line. Together these cut the block-context work the `read` tool performs on every non-raw read: for an 81KB TypeScript source with a mid-file window, 13.4ms to 4.45ms on a first parse and to 0.149ms once the tree is cached; for a 1.06MB source, 188.1ms to 55.8ms and to 0.440ms. The tree cache is bounded (12 entries, 4MiB of retained source) and verifies content byte-for-byte on every hit, so a hash collision can only cost a re-parse. The subtree skip is proven equivalent by differential comparison against the exhaustive walk across 4827 repository files and 38,616 window comparisons.

## [17.3.5] - 2026-08-16

### Fixed

- Fixed the native `xargs` builtin panicking in `-I`/`-i` replace mode when stdin is empty; it now exits successfully without running the command, matching GNU behavior.
- Fixed inline-code foreground color incorrectly carrying into plain text when a Markdown codespan ended exactly at a soft-wrap boundary.
- Fixed `wrapTextWithAnsi` leaving a trailing space plus a stray underline open/close pair on the line above a soft wrap when a style opened immediately after that space (e.g. `read this thread <underline>https://…`), a regression from the codespan color-bleed fix: only sequences that follow visible content now ride along with the current token, while sequences after whitespace still wait for the token they style.

## [17.3.4] - 2026-08-14

### Added

- Added the async `pdfToMarkdown` native API backed by `pdf-inspector`, with page numbering, page-count, OCR-needed-page, and encoding-issue metadata.

### Changed

- Docker images (`Dockerfile`, `scripts/install-tests/*.dockerfile`) build the native addon through the cargo/napi-rs backend (`OMP_NATIVE_BUILD_BACKEND=cargo`) instead of Bazel: a single fixed host target gains nothing from hermetic cross toolchains, and none of those images shipped bazelisk. `OMP_NATIVE_CARGO_PROFILE` picks the profile for that path (images use `ci`, local default stays `local`).

### Fixed

- Fixed the root Cargo workspace failing to load when a stale directory exists under `crates/` — e.g. a deleted crate whose directory survived `git reset --hard`. `members` no longer globs `crates/pi-*`, so a directory without a `Cargo.toml` can no longer break every cargo and Bazel build.
- Fixed Docker build contexts shipping nested build output: `.dockerignore` patterns are anchored at the context root, so bare `target/` and `dist/` matched neither `go-port/*/target` (~1.4 GB) nor `packages/*/dist` (~600 MB).
- Fixed `deviceCheckGenerateToken` aborting the whole process with `SIGTRAP` when called from a macOS session without GUI/graphic access (SSH, a launchd `LaunchDaemon`, a CI runner, a service account, a sandbox), which made every `openai-codex/*` OAuth model unusable for such accounts. `-[DCDevice isSupported]` synchronously opens an XPC connection to the per-user DeviceCheck metadata daemon, which exists only in an interactive GUI login session; without one the connection setup hits `_xpc_api_misuse` and traps before any completion handler runs, so the promise never rejects. The binding now checks the caller's security session for the `sessionHasGraphicAccess` attribute first and resolves `{ supported: false, error: … }` instead of touching DeviceCheck when it is absent ([#8353](https://github.com/can1357/oh-my-pi/issues/8353)).

## [17.3.1] - 2026-08-13

### Fixed

- Fixed `omp` failing to start on a clean Windows install with `Failed to load pi_natives native addon for win32-x64 ... The specified module could not be found` (LoadLibrary error 126). The shipped win32-x64 addon linked the dynamic MSVC CRT (`/MD`) and imported `VCRUNTIME140.dll` from the Visual C++ Redistributable, which is absent on a fresh Windows install. The addon now statically links the CRT (`+crt-static` for rustc plus the `static_link_msvcrt` cc feature for its C dependencies), so the `.node` imports only core Windows system DLLs ([#8439](https://github.com/can1357/oh-my-pi/issues/8439)).

## [17.3.0] - 2026-08-13

### Fixed

- Fixed an issue where shell-internal background jobs (such as `yes >/dev/null &`) could survive a one-shot shell session and consume CPU indefinitely after the command returned.

## [17.2.12] - 2026-08-08

### Changed

- Consolidated every shell builtin into one crate, `crates/pi-builtins` (the renamed and de-vendored `brush-builtins` fork), with one module per command. The 46 `crates/vendor/uu-*` crates, `crates/vendor/jaq`, `crates/pi-uu-grep`, `crates/pi-uu-diff`, and everything that had accumulated inline in `pi-shell` (`fd`, `cmp`, `which`, the moreutils set, and the `ps`/`top`/`pgrep`/`pkill`/`pidwait`/`kill`/`sleep`/`timeout`/`nohup` process builtins) now live beside the bash builtins they sit next to at runtime, and register through `pi_builtins::utility_builtins()` and `pi_builtins::process_builtins()`. `pi-shell/src/shell.rs` shrank by ~4,200 lines.

### Fixed

- Fixed `sort --compress-program` spawning its compressor and decompressor without the shell's working directory or exported environment, so a program installed only on the shell's `PATH` was not found, and with stderr inherited from the host process, where its diagnostics could corrupt the TUI. Both children now launch through the shell's child context and their stderr is forwarded to the command's own file descriptor.
- Fixed `realpath -q` exiting 0 after a failed operand; it suppresses the diagnostic but now reports failure, matching GNU.

### Removed

- Removed `crates/pi-uutils-ctx`. Utility builtins previously reached their stdio, working directory, and environment through a thread-local context installed around each invocation; they now receive an explicit `Host` value (`pi-builtins/src/host.rs`) carrying the command's file descriptors, the shell working directory, the exported environment, cancellation, and the accumulated exit status. The uutils entry-point plumbing (`uumain`, `UResult`/`UError`, `set_exit_code`, `crate_version!`) went with it; each utility is now an ordinary brush builtin implementing `host::Utility`.

## [17.2.11] - 2026-08-07

### Added

- Added support for Windows hosts in `bun run build`, enabling local N-API builds against VS Build Tools without requiring a pre-configured vcvars prompt.

### Changed

- Replaced the miniaudio (`maudio`) dependency with in-house platform audio backends for `AudioCapture`/`AudioPlayback`: CoreAudio AudioQueue on macOS, shared-mode WASAPI on Windows, and PulseAudio (ALSA fallback) loaded via `dlopen` on Linux. Removes the bindgen/libclang requirement and the Windows rustc-ICE workaround from the native build.

### Fixed

- Fixed CPU feature detection (AVX2) on Windows hosts, resolving an issue where the native addon loader and local builds incorrectly fell back to the baseline variant, while improving startup performance by ~270ms.
- Fixed `bun run build:bindings` failing on Windows due to incorrect resolution of the `@napi-rs/cli` entry point.
- Fixed a compiler crash (rustc ICE) when building the `maudio` package for Windows.
- Fixed synthesized macOS keyboard and pointer events suppressing physical user input.
- Fixed several Wayland input and capture issues, including preventing read-only calls from acquiring persistent input control, fixing GNOME Wayland pointer input initialization, and resolving conflicts between `libei` input and PipeWire screen capture.
- Fixed compilation of the `wayland-pipewire` Cargo feature.
- Improved security on Wayland by cleaning up orphaned world-readable RemoteDesktop restore tokens on startup.

## [17.2.10] - 2026-08-06

### Fixed

- Fixed per-window capture failing on Wayland with `InvalidTarget` errors for window IDs returned by `desktop.windows()`.
- Fixed `desktop.capabilities()` incorrectly reporting `capture: true` on Wayland builds compiled without the `wayland-pipewire` feature.

## [17.2.9] - 2026-08-05

### Changed

- Bounded fuzzy-find scored-match retention to the top-K results (worst-first heap) instead of collecting and fully sorting every hit; ranking and totals are unchanged ([#7415](https://github.com/can1357/oh-my-pi/issues/7415)).

### Fixed

- Fixed newer OMP versions deleting a freshly created older native addon cache directory during concurrent startup, which could interrupt extraction with `ENOENT`.

## [17.2.7] - 2026-08-03

### Added

- Added missing procps/BSD output format specifiers and aliases to the in-process `ps` shell builtin, including support for columns like `tpgid`, `pri`, `flags`, `wchan`, and various user/group/time fields.
- Updated `ps -j` to include the TPGID column, `ps -l` to display the single-character S column, and the STAT column to support the `+` foreground process group flag.

## [17.2.6] - 2026-08-03

### Added

- Added non-blocking, process-owned `FileLock` bindings using abstract Unix sockets on Linux, named mutexes on Windows, and persistent `flock(2)` sidecars on other Unix platforms.

## [17.2.5] - 2026-08-03

### Breaking Changes

- Replaced DesktopSession.execute(actions, window) and action batches with dedicated per-operation methods for capture, pointer, keyboard, window, and accessibility. Capture capabilities now apply per call, and coordinate input requires a prior frame for the same target.

### Added

- Added a cross-platform, in-process ps shell builtin supporting BSD/procps selection forms, custom output columns, sorting, process metrics, and header suppression.
- Added unified desktop backends for macOS, Win32, X11, and Wayland behind a single session API, featuring capture-free window discovery, isolated capture, explicit background/foreground delivery, native accessibility trees (AX/UIA/AT-SPI) with generational references, and structured errors for unsupported background input.

### Fixed

- Fixed accessibility snapshots incorrectly marking a window root as focused based on its app-local AXFocused attribute when another application held global focus; the root annotation now correctly reflects the global window-roster focus flag.
- Improved coordinate-frame error messages for pointer input before capture, out-of-frame coordinates, and between-display points to clearly explain the capture-frame contract and remedy instead of throwing a generic bounds check.
- Fixed duplicated characters in AppKit targets on macOS caused by background keyboard events being posted through both CoreGraphics and SkyLight; events are now delivered once via the authenticated SkyLight route.

## [17.2.2] - 2026-07-31

### Changed

- Updated native HTML-to-Markdown rendering to html-to-markdown-rs 3.9.2 defaults, which may result in formatting differences (such as fenced code blocks and cycling nested-list bullets) compared to version 2.30.0.

### Fixed

- Fixed a heap corruption crash when opening PulseAudio on Linux ARM64 by shipping target-specific miniaudio Rust layouts for GNU and musl native addons.
- Fixed local Bazel addon builds on NixOS by exposing system CMake tools to sandboxed build scripts and correctly bundling Opus.
- Fixed workspace native addon loading to correctly prefer the workspace build over an installed leaf package.
- Fixed process crashes caused by pathological HTML inputs; conversions that exceed the native-stack DOM depth limit now reject instead of returning silently truncated Markdown.

## [17.2.1] - 2026-07-30

### Fixed

- Fixed the `computer` tool advertising Wayland support that never worked: on the default rootless XWayland (GNOME/KDE/sway) the X11 root window has no readable pixmap, so root `GetImage` failed on every screenshot with a raw `BadMatch` protocol dump. `Monitor::all` now probes root drawability at initialization and fails fast with an actionable `DESKTOP_BACKEND_UNAVAILABLE` message naming the rootless-XWayland constraint, and `docs/computer-use.md` now lists rootless XWayland as unsupported ([#7085](https://github.com/can1357/oh-my-pi/issues/7085)).

## [17.2.0] - 2026-07-30

### Changed

- Split the native voice engine (miniaudio capture/playback, WebRTC peer, Opus media) out of the `pi-natives` addon crate into a napi-free `pi-voice` rlib. The addon keeps thin `#[napi]` adapters, so the JS API is unchanged; the webrtc/opus/miniaudio dependency graph now compiles once into the library and no longer rebuilds with the addon leaf (which recompiles every release via its version-sentinel edit).
- Release binaries now build in parallel with the test fan-out; npm leaf publishing moved to a dedicated post-validation job (`release_native_leaves`), and darwin release bazel caches are pre-warmed on native-affecting main pushes — cutting release wall time from the previous serialized tests → cold darwin build pipeline.

## [17.1.8] - 2026-07-28

### Fixed

- Fixed an issue on macOS (darwin) where the native addon delivered zero AudioCapture callbacks, which prevented microphone audio from being captured.

## [17.1.6] - 2026-07-27

### Changed

- CI now exports Bazel disk caches only after exact misses and reuses one native addon artifact across Linux test and release jobs. macOS release jobs now build only their own architecture.
- Native addons now build with Bazel (rules_rust + hermetic zig cc toolchains for linux-gnu/musl, host Xcode for darwin, and a hermetic clang-cl + xwin toolchain for windows-msvc) instead of the napi CLI + cargo-zigbuild/cargo-xwin pipeline. `bun run build` drives `scripts/bazel-natives.ts`; TypeScript binding regeneration moved to `bun run build:bindings` (needed only when the Rust API surface changes). CI caches through a content-addressed bazel-remote action cache instead of sccache + target-directory snapshots, cutting warm native rebuilds from ~20 minutes to seconds and cold cache-hit builds to ~2.5 minutes.

### Fixed

- napi binding build failures now surface the exit code and the tail of stdout/stderr instead of a bare "napi build failed" message ([#6799](https://github.com/can1357/oh-my-pi/pull/6799)).
- Silenced cross-platform Rust build warnings: dead-code on unix-only fields/helpers in `pi-uutils-ctx`, `pi-shell` (fd owner filters, coreutils argv), and vendored `uu-find`/`uu-stat` when compiling for Windows, and deprecated `libc::time_t` casts in `pi-iso` on musl. `pi-walker` now declares the `windows-sys` features it uses (`Win32_Foundation`, `Win32_Security`, `Win32_Storage_FileSystem`, `Win32_System_IO`) instead of relying on workspace-wide feature unification.

## [17.1.5] - 2026-07-27

### Fixed

- Fixed the native `sort` builtin panicking with `SendError(..)` at `chunks.rs:248` when the chunk-channel receiver disconnected early (e.g. a consumer thread stopping after an error or closed output); the reader now stops gracefully instead of unwrapping the failed send, and a panicking external-sort worker thread is surfaced as an error instead of silently emitting truncated output ([#6736](https://github.com/can1357/oh-my-pi/issues/6736)).

## [17.1.4] - 2026-07-26

### Added

- Added the `@oh-my-pi/pi-natives/desktop` factory entry, which defers native addon loading until a desktop worker initializes its session.

### Fixed

- Fixed Linux native audio over forwarded PulseAudio servers: capture now handles 125 ms Android fragments without stalling, and playback buffers enough audio to avoid TCP underruns and stuttering ([#6628](https://github.com/can1357/oh-my-pi/pull/6628) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed older running OMP versions deleting newer native addon cache directories during cleanup, which could race a new version's first-run extraction and crash with `ENOENT`.
- Fixed macOS computer screenshots occasionally returning the pre-action frame instead of reflecting completed keyboard and pointer input ([#6595](https://github.com/can1357/oh-my-pi/pull/6595) by [@wolfiesch](https://github.com/wolfiesch)).

## [17.1.3] - 2026-07-24

### Changed

- `astEdit` without an explicit `lang` now rewrites mixed-language paths per file (each file parsed in its own inferred language, patterns compiled per language) instead of erroring when the path/glob spans multiple languages. A pattern that parses in no discovered language is still reported (or fails the call under `failOnParseError`); files whose language cannot be inferred surface as per-file parse errors instead of aborting the whole call.

## [17.1.2] - 2026-07-24

### Fixed

- Fixed native addon builds with CMake 4.x (bundled opus policy floor) and stopped passing `-C target-cpu=native` on darwin arm64, which baked build-host CPU features into shipped addons and broke `ring` compilation.

## [17.1.1] - 2026-07-24

### Added

- Added native `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` classes for low-latency microphone capture, gapless speaker playback, and WebRTC offer/answer sessions with Opus media and `oai-events` data-channel delivery.
- Added a macOS `deviceCheckGenerateToken` export that generates Apple DeviceCheck attestation tokens natively: it drives `DCDevice.generateToken` through raw Objective-C runtime FFI with a hand-built completion block literal and a bounded one-second wait, resolving `{ supported, tokenBase64, error, latencyMs }` to mirror the ChatGPT desktop app's `devicecheck.node` addon contract. Non-macOS builds resolve `supported: false` without touching the network.
- Added a genuine native desktop backend for computer use, bundled in the core addon on every published platform: macOS Quartz/CGEvent, Windows Win32/`SendInput`, and a pure-Rust Linux X11 backend (`x11rb` capture over the display socket, XTest input with keysym mapping) that links no GUI system libraries — so Linux x64/arm64, glibc and musl are all supported and headless hosts are unaffected. Wayland sessions work through XWayland. Execute batches enforce a 60-second native deadline (`DESKTOP_DEADLINE_EXCEEDED`) and never emit input after it expires; unsupported pure-Wayland capture and out-of-XTest-range or negative-origin coordinate layouts fail closed.

### Fixed

- Fixed macOS computer screenshots taking roughly 30 seconds under Bun by replacing xcap's deprecated window-list capture with a bounded system capture path; direct screenshots now complete in under half a second on the verified host.

## [17.0.8] - 2026-07-22

### Added

- Added jsdiff-compatible native diff exports: `diffLines`, `diffWords`, `diffLineRuns`, and `structuredPatchHunks`.
- Added batch vector kernels for mnemopi recall paths: `cosineSimilarityPairs`, `vectorIndexTopK`, and `mmrRerankIndices`.

### Changed

- Updated diff functions (`diffLines`, `diffWords`, `diffLineRuns`, `structuredPatchHunks`) to process UTF-16 code units natively end to end via `Utf16String`, supporting ill-formed JS strings with unpaired surrogates without throwing or converting to UTF-8.

### Fixed

- Fixed a critical issue where the in-process `rm` builtin treated an empty path operand as the current working directory, causing `rm -rf ""` to recursively delete the current directory. Empty operands are now rejected, matching GNU `rm` behavior.

### Removed

- Removed unused `similar` crate dependency and dev-dependency on npm `diff`.

## [17.0.5] - 2026-07-18

### Added

- Added optional PTY start callbacks that report the spawned child PID before command completion.

## [17.0.3] - 2026-07-17

### Fixed

- Fixed `~` (tilde) not expanding for every element of a brace expansion in the bash tool, so `mkdir -p ~/project/{a,b}` now creates both `a` and `b` under `$HOME/project` instead of leaving a literal `~/project/b` in the working directory ([#5819](https://github.com/can1357/oh-my-pi/issues/5819)).
- Fixed ANSI text wrapping to close and restore OSC 8 hyperlinks at physical line boundaries, preventing link targets from leaking into appended content ([#5885](https://github.com/can1357/oh-my-pi/issues/5885)).

## [17.0.2] - 2026-07-17

### Fixed

- Fixed an issue where running `uv run --extra <package> pytest` bypassed native pytest minimization due to a wrapper parsing error.
- Fixed a bug where timed-out shell pipelines dropped captured output and could cause Windows hosts to terminate during teardown. (#5316)

## [17.0.1] - 2026-07-16

### Fixed

- Fixed the pi-natives version sentinel emitting "reinstall to re-sync" when a long-lived process survives an in-place upgrade: the loader now detects that the resident addon exposes a _prior_ release's sentinel and reports "omp was upgraded while this session was running — restart to pick up the new version (disk is already consistent)" instead of misdiagnosing it as a stale on-disk file ([#4812](https://github.com/can1357/oh-my-pi/issues/4812)).

## [17.0.0] - 2026-07-15

### Fixed

- Fixed the in-process grep builtin to correctly handle escaped alternation (\|) in default and -G (GNU basic-regex) searches, while preserving the correct regex dialects for -E, -F, and -P.

## [16.5.2] - 2026-07-14

### Fixed

- Fixed an issue where Windows PTY callers were forced through shell command re-quoting by supporting direct executable and argument launching.

## [16.4.6] - 2026-07-12

### Added

- Added an in-process `readlink` shell builtin (vendored from uutils coreutils 0.8.0), supporting `-f`/`-e`/`-m` canonicalization, `-n`/`-z` delimiters, and `-v`/`-q`/`-s` verbosity, with path operands resolved against the shell working directory.
- Added in-process shell builtins for `realpath`, `touch`, `stat`, `date`, `mktemp`, `seq`, `yes`, `printenv`, `ln`, `truncate`, `tac`, `nproc`, `uname`, `whoami`, and `hostname` (vendored from uutils coreutils 0.8.0), plus native `which` (shell PATH lookup) and `diff` (unified output, `-U`/`-q`/`-N`, binary detection, recursive directory compare) builtins. All resolve path operands against the shell working directory, read the shell's exported environment, and honor abort/timeout cancellation; `ln` is gated with the destructive set (`PI_DISABLE_UUTILS_DESTRUCTIVE`), and system-mutating modes (`date --set`, hostname setting) are disabled.

### Fixed

- Fixed `ast_edit` rejecting byte-identical duplicate replacements as "Overlapping replacements detected": multiple rewrite ops matching the same node with the same output now collapse into one deterministic edit (deduped in both the preview listing/counts and the apply pass), so only genuinely divergent overlaps error.

## [16.4.5] - 2026-07-11

### Added

- Added context-safe, in-process shell builtins for common utilities including base64, basename, dirname, cut, tee, tr, paste, comm, sed, xargs, jq, and the md5sum/sha/b2sum checksum family. These builtins run without spawning external binaries, support pipelines, respect shell-relative paths and environment variables, and honor abort/timeout cancellation.

## [16.4.4] - 2026-07-11

### Fixed

- Fixed fuzzyFind tie-breaking logic to prefer shallower paths first, preventing deeply nested matches from ranking above shallow ones on score ties.
- Fixed macOS installation issues for pi-natives by statically linking PCRE2, removing the runtime dependency on Homebrew's dynamic libpcre2-8.0.dylib library.

## [16.4.3] - 2026-07-11

### Fixed

- Optimized non-recursive glob patterns (e.g., `dir/*.json`) to prevent traversing entire subtrees, significantly improving performance and preventing timeouts when searching large directories.
- Fixed native filesystem searches (`glob`, `grep`, and AST search/edit) incorrectly excluding explicitly rooted directories due to ancestor ignore rules.

## [16.3.13] - 2026-07-09

### Fixed

- Fixed unbounded memory growth in the native bash output bridge when a command produces output faster than the JS event loop consumes it: the shell streaming path now uses a bounded chunk queue with real backpressure (pipe readers park until the JS callback catches up, parking the child on its pipe) instead of buffering the entire surplus in memory. No output is dropped — the rolling tail view, `[raw output: artifact://…]` lossless capture, and byte accounting are unaffected ([#4078](https://github.com/can1357/oh-my-pi/issues/4078)).
- Fixed `readImageFromClipboard` on Windows failing with "could not be converted to the appropriate format" for screenshots taken by Qt-based tools such as PixPin and Snipaste. arboard hands their `CF_DIBV5` payload (`BI_RGB` plus an alpha mask, rewritten to `BI_BITFIELDS`) to a header-less BMP decode that mis-places the pixel offset for V4/V5 bitfield headers; the native reader now falls back to decoding the raw `CF_DIB` clipboard bytes directly, so image paste no longer depends on the PowerShell bridge. ([#3426](https://github.com/can1357/oh-my-pi/issues/3426))
- Fixed OMP being killed outright (OOM on memory-capped hosts such as WSL) when an output-heavy bash command hit its timeout: the unbounded output-bridge backlog could grow by gigabytes before cancellation and starve the JS event loop far past the deadline; with the bounded backpressured bridge the run resolves at its deadline with flat memory ([#4866](https://github.com/can1357/oh-my-pi/issues/4866)).

## [16.3.12] - 2026-07-08

### Fixed

- Fixed the native build script failing to locate the `@napi-rs/cli` `napi` binary on Windows because the `PATH` lookup joined entries with a Unix `:` separator instead of the platform delimiter (`path.delimiter`).
- Fixed a Windows regression where an abnormal `omp` exit or bash cancellation could `TerminateProcess` unrelated `pwsh.exe` / `powershell.exe` sessions (including other Cursor terminal tabs). `SpawnRegistry` stored only the raw pid of each brush-spawned child and re-opened it via `Process::from_pid` at cancellation time; between those two moments Windows could recycle a freed pid onto an unrelated PowerShell, and `signal_tree` then walked the wrong subtree via Toolhelp. The observer now pins a stable `Process` handle at spawn time — on Windows the open handle keeps the pid slot reserved, on Linux the pidfd carries identity, on macOS the `(pid, start_time)` triple detects impersonation — so cancellation can only reach children this run actually launched. The registry sweeps exited entries once the recorded set crosses a small threshold so a long bash loop of short external commands cannot pin one owned OS handle per historical spawn. ([#4605](https://github.com/can1357/oh-my-pi/issues/4605))

## [16.3.6] - 2026-07-04

### Changed

- Rewrote native `grep` directory search to stream while the tree is walked: a work-stealing parallel traversal feeds searchers directly, and content-mode match budgets now terminate the walk itself instead of only the search. Limited searches keep deterministic path-ordered first pages at every budget size via windowed commits, with oversized files still deferred behind normal-sized results.
- Faster filesystem walker: gitignore/ignore state is now derived from each directory's own listing instead of up to five per-directory stat probes, per-entry allocations were eliminated through pooled directory scratch buffers and reusable path builders, and a new parallel unordered file-candidate walk API backs full-scan grep.
- Concurrent `grep` calls are no longer serialized against each other, searchers are reused per worker instead of rebuilt per file, and non-multiline patterns opt into grep-regex's line-terminator fast path with a compatibility fallback.

## [16.3.0] - 2026-07-02

### Added

- Added `workingDir` to `ShellRunResult` to allow hosts to synchronize the session's current working directory without executing a hidden probe command.

### Fixed

- Fixed an issue where panics in native worker tasks (such as grep, AST parsing, globbing, workspace listing, HTML-to-markdown conversion, fuzzy finding, and clipboard image reading) would abort the host process instead of properly rejecting the returned JavaScript Promise.
- Fixed a crash on Windows under low memory or commit charge conditions when spawning worker threads for token counting or sorting operations.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed high memory usage in native `astGrep` and `astMatch` by retaining only the requested page window of match payloads during broad searches while preserving exact totals.

## [16.2.10] - 2026-06-30

### Added

- Added a platform-native no-ignore filesystem traversal path for `glob`/`grep` scans, using `getattrlistbulk` on macOS, `getdents64`/`statx` on Linux, and `NtQueryDirectoryFile` with `FileIdFullDirectoryInformation` on Windows while preserving the existing `WalkBuilder` path for gitignore-aware scans.

## [16.2.7] - 2026-06-30

### Added

- Added embedded Silver TrueType font rendering support to `renderSnapcompactPng`, featuring automatic per-glyph fallback for missing bitmap characters and anti-aliased scaling for East Asian wide code points.
- Added the `snapcompactSupportedChars` function to check font capability for specific characters.

## [16.2.5] - 2026-06-28

### Fixed

- Fixed the in-process `grep` builtin rejecting GNU-grep's `--color`/`--colour` (with or without `=WHEN`) and `--version` flags. The shadowing rejection broke bash's near-universal `alias grep='grep --color=auto'`, causing bare `grep` in any pipeline to fail with exit 2. The builtin now accepts and ignores `--color[=WHEN]` (its output goes through in-process file descriptors, never a TTY, so ANSI injection would corrupt downstream consumers) and reports its version through the context streams ([#3755](https://github.com/can1357/oh-my-pi/issues/3755)).

## [16.2.4] - 2026-06-28

### Fixed

- Fixed a crash in the in-process `tail` builtin where the host process would abort with a `BrokenPipe` panic if the stdout consumer closed the pipe early.

## [16.1.23] - 2026-06-26

### Added

- Added Nix and Mermaid syntax highlighting support to `highlightCode`/`supportsLanguage` via vendored `Nix.sublime-syntax` and `Mermaid.sublime-syntax` definitions plus `nix`, `mermaid`, and `mmd` aliases.
- Added in-process [uutils](https://github.com/uutils/coreutils)-backed shell builtins to the embedded brush `Shell`: `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `ls`, `find`, `grep`, `mkdir`, `rm`, and `mv`. These vendored + patched utilities run inside the shell process (no `fork`/`exec`), resolve path operands against the shell working directory, route stdio through the command's (possibly piped/redirected) file descriptors, read the shell's exported environment, and honor abort/timeout cancellation (a blocked `stdin` read unwinds cleanly). `grep` is built on the ripgrep `grep-*` crates and `find` on `uutils/findutils`; the rest are pinned to `uutils/coreutils` 0.8.0 (matching the bundled `uucore`). Registration is gated: set `PI_DISABLE_UUTILS_BUILTINS` to fall back to the system binaries for the whole set, or `PI_DISABLE_UUTILS_DESTRUCTIVE` / `PI_DISABLE_RM_BUILTIN` / `PI_DISABLE_MV_BUILTIN` to disable only the destructive `rm`/`mv` shadows.

## [16.1.17] - 2026-06-24

### Added

- Added `setHangulCompatJamoWidthOverride(value)` to override the Hangul Compatibility Jamo (U+3131..U+318E) display width at runtime via a process-global atomic, instead of relying solely on the compile-time `cfg!(target_os = "macos")` heuristic. The actual width is decided by the client terminal (not the host OS), so the TUI resolves it from the terminal identity and pushes the result here. Encoding: `0` = platform default (macOS narrow, otherwise UAX#11), `1` = narrow (1 cell), `2` = wide (2 cells), `3` = Unicode width (no correction). The leaf width helpers read this override, so no width/slice/truncate/wrap signatures change.

## [16.1.15] - 2026-06-22

### Added

- Added `Shell.liveBackgroundJobCount()` reporting the number of live external background jobs (`&`/`nohup` children) on a persistent session, reaping completed jobs first via a silent `poll()`. Lets the host retain a shell whose background process is still running instead of dropping it (which would SIGKILL the child via kill-on-drop).

### Fixed

- Fixed `pi_natives` failing to load in Bun worker threads on macOS x64 when the host built only the `modern` (AVX2) variant. The runtime detector's `child_process.spawnSync("sysctl", …)` returned null from the worker even though the build-time detector succeeded in the parent, so `loadNative()` resolved `variant=baseline` and searched a file list that excluded the on-disk `pi_natives.darwin-x64-modern.node`. Resolution now prefers `Bun.spawnSync`, tries `/usr/sbin/sysctl` before bare `sysctl`, and caches the first context's verdict via a private env key so child workers and subprocesses inherit it instead of re-detecting ([#3238](https://github.com/can1357/oh-my-pi/issues/3238)).

## [16.1.14] - 2026-06-22

### Fixed

- Enabled full Julia syntax highlighting support in highlightCode

## [16.1.12] - 2026-06-21

### Added

- Added Julia syntax highlighting to `highlightCode`/`supportsLanguage` via a vendored `Julia.sublime-syntax` folded into syntect's default set (`jl`/`julia` aliases); syntect ships no Julia grammar.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Changed renderSnapcompactPng to return a promise instead of a string value

### Fixed

- Fixed directory `grep` continuing to walk large trees after the requested content match budget had already been satisfied, which could make broad coding-agent searches time out before returning the first page of matches ([#2738](https://github.com/can1357/oh-my-pi/issues/2738)).

## [16.0.11] - 2026-06-19

### Fixed

- Fixed native shell execution reporting `pi-natives:command: syntax error at end of input` for a valid `&&`/`;` chain whose later pipeline stage is a compound command, e.g. `echo x && git log | while read h; do …; done | head`. The output minimizer's segmented-chain runner rebuilds each chain segment from the brush-parser AST via `pipeline.to_string()` and re-executes that string, but `simple_segment` only validated the _first_ pipeline stage — so a compound later stage (`while`/`for`/`if`/subshell) was re-serialized without its terminator (`Display` drops it) and re-run as broken shell. `simple_segment` now requires every stage to be a `Display`-safe simple command, and — closing the recurring class of brush `Display` round-trip divergences (here-doc close-tag quoting, multi-byte char/byte offsets) at its root — each reconstructed segment is re-parsed and must match the original pipeline shape before the chain runner executes it; any divergence runs the command whole via the unsegmented path instead of corrupting it.

## [16.0.7] - 2026-06-18

### Added

- Added Fortran support to the AST tooling, including file/alias resolution.

## [16.0.6] - 2026-06-18

### Removed

- Removed the `cache` option from `GrepOptions`

## [16.0.4] - 2026-06-17

### Fixed

- Fixed `summarizeCode` BFS unfold aborting the entire pass when it hit an oversized, un-unfoldable leaf span (e.g. an HTML `<style>` raw-text block, an embedded blob, or a minified line) whose only unfold candidate is its whole body. The overflow check used to `break` the breadth-first loop, so any large leaf encountered before its siblings starved the rest of the tree — an HTML page summarized to `<style> ... </style>` plus `<div class="page"> ... </div>`, collapsing the document body into one dead `...`. An overflowing span is now skipped (left folded, its subtree unexplored) and the BFS keeps unfolding the remaining queued siblings, so structured siblings like the `<body>` DOM are revealed up to `unfoldLimit` while the oversized leaf stays folded.

## [16.0.2] - 2026-06-16

### Added

- Added Emacs Lisp (`.el`, `.emacs`, `emacs-lisp`/`elisp`) support to native tree-sitter language inference, enabling astGrep/astEdit, summarizeCode, and blockRangeAt on Emacs Lisp source.

## [16.0.1] - 2026-06-15

### Fixed

- Fixed shipped Linux native addons failing to load with `version 'GLIBC_2.39' not found` on distributions older than Ubuntu 24.04. After native builds moved onto the Ubuntu 24.04 (glibc 2.39) self-hosted runner, the x64 addon was a plain host build that linked the runner's glibc and the arm64 cross-build floated up to GLIBC_2.30; the `linux-x64` (baseline + modern) and `linux-arm64` addons are now built through `cargo-zigbuild` against a pinned glibc 2.17 floor, restoring portability to any glibc ≥ 2.17 (CentOS 7 / Ubuntu 14.04 era).
- Fixed Linux native builds hard-failing when `RUSTC_WRAPPER=sccache` points at an unavailable shared cache backend. The native build script now retries the `napi` build once without the sccache wrapper after a cache-storage startup failure, so install smoke tests and local fallback builds can proceed while preserving the cached fast path when the backend is healthy.
- Fixed shell cancellation cleanup failing to reap child processes inside containers whose guest kernel was built without `CONFIG_PROC_CHILDREN` (e.g. some Kata/microVM guests): the Linux descendant walk relied solely on `/proc/<pid>/task/<tid>/children`, which does not exist there, so `children()` / `live_descendants()` returned empty and termination waves never reached the children. It now falls back to scanning `/proc` and grouping by parent pid (the primitive the macOS path already uses) when no `children` file is readable, keeping the cheap per-task fast path on kernels that support it.

## [15.13.1] - 2026-06-15

### Fixed

- Fixed `pi-natives` deadlocking at addon load (`dlopen` hang) on some Linux hosts. The load-time Tokio runtime install added in 15.12.6 ran inside `#[module_init]`, which executes while the dynamic-loader lock is held; building the multi-thread runtime there eagerly spawns worker threads, and a fresh worker blocking to acquire the loader lock the init thread still owns deadlocks the whole load (every native consumer hangs at startup). The runtime is now built from an exported `__ompInstallTokioRuntime` that the JS loader calls once, immediately after `dlopen` returns and before any async native runs; `#[module_init]` only installs the crash handler. napi-rs materializes its runtime lazily on first async use (`RT` is a `LazyLock`) and `create_custom_tokio_runtime` only records the runtime, so the post-load install is still adopted — preserving the Windows commit-limit thread probing/back-off from 15.12.6 without spawning under the loader lock.
- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `delete block` / `insert after block` ops) returning no block for a construct whose opening line follows a blank line — most visibly in Swift, where `replace block` on a SwiftUI `var body: some View {` (or any statement/declaration after a blank line) failed with "could not resolve a syntactic block… (unsupported language, blank/closer line, or parse error)". tree-sitter-swift inserts a zero-width separator node at the start of a statement that follows a blank line; the resolver queried the first content column with a zero-width point range, which `ts_node_named_descendant_for_point_range` absorbs into that invisible node and bubbles back up to the enclosing body (or the file root), so no block was found. The query now spans the first content character (a one-column-wide range) so it skips zero-width nodes and descends into the node that actually begins on the line.
- Fixed native shell execution reporting `unterminated here document sequence` for a multi-command line that contains a here-doc with a quoted or escaped delimiter (`<<'TAG'`, `<<"TAG"`, `<<\TAG`) followed by another command (e.g. a `sqlite3 … <<'SQL' … SQL` query followed by an `echo`/second command). The output minimizer's segmented-chain runner rebuilds each `&&`/`;`/newline segment from the brush-parser AST via `pipeline.to_string()`, and that `Display` impl re-emits a quoted/escaped here-doc's _closing_ delimiter with its quotes intact (`'SQL'` instead of the required bare `SQL`) — an invalid close tag that the re-run segment never matches. Here-doc-bearing pipelines are now ineligible for segmentation, so the command runs whole via the unsegmented path (where the executor parses it correctly); a lone here-doc was unaffected because it was never segmented.
- Fixed native addon loading leaving stale `~/.omp/natives/<version>` cache directories behind after updates; successful loads now remove older version directories best-effort.
- Fixed Linux source-built native addons hanging during package import by keeping the Windows-only Tokio worker probe out of non-Windows module initialization ([#2553](https://github.com/can1357/oh-my-pi/issues/2553)).
- Fixed `pi-iso` Windows clippy failures in symlink placeholder metadata, block-clone path resolution, and readonly cleanup handling ([#2379](https://github.com/can1357/oh-my-pi/pull/2379) by [@oldschoola](https://github.com/oldschoola)).

## [15.12.6] - 2026-06-14

### Fixed

- Fixed `pi-natives` aborting the whole process at addon load on memory-constrained Windows hosts (`OS can't spawn worker thread`, typically OS error 1455 — pagefile/commit limit). napi-rs builds its own Tokio runtime with one eagerly-spawned worker per CPU, and that spawn _panics_ rather than erroring, so under `panic = "abort"` the failure was uncatchable. The addon now installs its own runtime at load: it probes how many threads the OS will actually grant (starting from the Tokio default, clamped to a small ceiling since CPU-heavy native work runs on libuv/Rayon and Tokio's separate blocking pool, not the scheduler workers), sizes the multi-thread runtime to the probed count, and falls back to a current-thread runtime if not even one worker can be spawned — no panic on any path.

## [15.12.4] - 2026-06-13

### Fixed

- Fixed native shell execution rejecting quoted heredocs whose closing delimiter is the final line without a trailing newline, matching bash paste-run snippets.

## [15.11.7] - 2026-06-12

### Added

- Added the X.org misc `6x12` and `8x13` BDF fonts (public domain, vendored in `crates/pi-natives/src/fonts/`) to `renderSnapcompactPng`, alongside two new options for the snapcompact eval-winner shapes: `stretch: false` renders glyphs at natural size on the requested cell box while keeping the 4-bit indexed encoder (e.g. 8x13 glyphs on an 8x16 pitch, the "8on16" shapes), and `columns: 2` flows pre-wrapped newline-separated lines down two newspaper columns with a 3-cell gutter (the "doc" shapes); in doc mode sentence hues also advance across a terminator followed by a newline
- Added a line-break marker to `renderSnapcompactPng`: `U+2588` (FULL BLOCK) fills its entire cell box with pitch-black ink in both grid and doc layouts, ignoring the sentence hue and dim state, and counts as a sentence boundary after a `.`/`!`/`?` terminator

### Changed

- `renderSnapcompactPng` now clips the frame height to the text: the PNG stays `size` pixels wide but is only `usedRows * lineRepeat * cellHeight` tall (dim toggles are zero-width; doc layout counts `\n`-separated lines), so a partially filled frame no longer pads to a full square of blank rows
- `renderSnapcompactPng` indexed frames now narrow the palette to the colors actually printed and pick the matching bit depth (plain `bw` 1-bit, dim/banded 2-bit, sentence hues up to 4-bit), and both encode paths moved from `Balanced` to `High` deflate: `8on16-bw` frames shrink ~35%, `6x12-dim` ~10%, sentence-hue doc frames ~9% — pure PNG, no decoder-side changes (lossless WebP was measured at only ~8% beyond this and rejected for provider-compatibility risk)

## [15.11.4] - 2026-06-12

### Fixed

- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `insert after block` ops) failing on extensionless shell rc/profile files. `Path::extension` returns `None` for both bare (`zshrc`) and dotfile (`.zshrc`, `.bashrc`) forms, so language inference fell through to "unrecognized" and block resolution was permanently unresolvable on those files — an agent retrying the block op would loop on the same error. Known shell rc/profile basenames (`zshrc`/`zshenv`/`zprofile`/`zlogin`/`zlogout`/`bashrc`/`bash_profile`/`bash_login`/`bash_logout`/`bash_aliases`/`profile`/`kshrc`/`mkshrc`/`shrc`, with or without a leading dot) now resolve to the bash grammar.

## [15.11.0] - 2026-06-10

### Breaking Changes

- Changed `renderSnapcompactPng(text, options)` to return a base64-encoded PNG `string` instead of a `Uint8Array`

### Added

- Added dim-span ink toggles to `renderSnapcompactPng`: `U+000E`/`U+000F` in the input switch to a dim gray ink (palette index 9) and back without occupying a glyph cell, letting callers visually de-emphasize spans such as archived tool output
- Added `renderSnapcompactPng(text, options)`: rasterizes pre-normalized text onto a square PNG in an eval-validated snapcompact shape. Options select the bundled font (`5x8` X.org BDF or `8x8` unscii-8, both public domain, shipped in `crates/pi-natives/src/fonts/`), the ink variant (`sent` six-hue sentence cycling or `bw` black), line repetition (each text line printed N times, copies on a pale highlight band), and a target cell size — cells differing from the font's natural cell render via Lanczos3 stretch into an anti-aliased RGB frame (e.g. the OpenAI-optimal 6x6 unscii shape); native-cell shapes encode as 4-bit indexed PNG. Replaces the JS rasterizer/PNG writer previously in `@oh-my-pi/pi-agent-core`.

## [15.10.12] - 2026-06-10

### Added

- Added deterministic shell-output minimization to the native shell pipeline, including opt-in per-command rewrite telemetry surfaced through `executeShell().minimized` for callers that want compact inline output plus a separately persisted original capture.

### Fixed

- Fixed native crash-log directory resolution diverging from the JS logger when `PI_CONFIG_DIR` is absolute: the config root now mirrors `path.join(homedir, PI_CONFIG_DIR)` semantics (absolute values re-rooted under `$HOME`, `.`/`..` components normalized), and an empty `PI_CODING_AGENT_DIR` no longer disables XDG state-dir resolution.
- Fixed shell-output minimization condensing `pyright`/`basedpyright` `--outputjson` runs into a diagnostics summary; machine-readable JSON output now passes through untouched.
- Fixed `pi-natives` aborting Bun on Windows with `memory allocation of N bytes failed` and no backtrace whenever the native cdylib hit a Rust panic or out-of-memory condition. The release profile uses `panic = "abort"`, so neither default handler emitted any context — Bun received only the bare message and tore down the TUI session before flushing. Module load now installs `std::panic::set_hook` and `std::alloc::set_alloc_error_hook` via `#[napi::module_init]`; both hooks capture `Backtrace::force_capture()` (so it works without `RUST_BACKTRACE=1`) and write a structured report — pid, thread, size/alignment for OOM, source location and message for panics, full backtrace — to the same logs directory the JS logger uses (`$XDG_STATE_HOME/omp/logs/` on Linux/macOS when the user has migrated to XDG and `PI_CODING_AGENT_DIR` isn't customized, otherwise `~/.omp/logs/`) and to stderr before the host process exits. The OOM hook prints the canonical allocation-failure line before any allocation-prone diagnostics and aborts immediately on re-entry, so real process-wide OOM still surfaces the fallback message instead of recursing in the report path ([#2211](https://github.com/can1357/oh-my-pi/issues/2211)).

## [15.10.11] - 2026-06-10

### Added

- Added a `maxCountPerFile` option to `grep` that caps how many matches a single file may contribute, so one hot file can no longer exhaust the global `maxCount` budget in path order and starve every file sorted after it out of the result set entirely.
- Added `PI_DEBUG_STARTUP` streaming markers to the addon loader (`native:loadNative:start`, `native:extractEmbeddedAddon:start`, `native:require:<file>`, `native:loadNative:done`), written with synchronous stderr writes so a hang inside first-run extraction or `dlopen()` — which blocks the event loop and defeats any timer-based diagnostics — still leaves the failing step as the last marker on stderr.
- Added a `skippedOversized` count to `GrepResult`: directory walks now report how many files were silently skipped for exceeding the 4MB per-file grep limit (previously they vanished without a trace, letting callers conclude a symbol does not exist).

### Changed

- Parallelized the mtime-ranked `glob()` walk (the path OMP `find` always takes): per-thread bounded top-N heaps replace the single-threaded full-stat traversal, so large trees rank in a fraction of the wall clock while keeping the deterministic mtime-desc/path ordering and bounded memory.

### Fixed

- Fixed cross-line grep being a silent no-op on real files: `multiline` set the `(?m)` flag on the regex matcher but never enabled `multi_line` on the `Searcher`, which stayed line-oriented, so any pattern spanning a `\n` returned zero matches with no error.

## [15.10.5] - 2026-06-08

### Added

- Added the `enclosingBlockBoundaries` native API (with `EnclosingBoundaryOptions` and `LineRange` types) that returns, for a set of visible line ranges, the off-window boundary lines of every multi-line tree-sitter node whose span crosses the window — the closer when an opener is shown and the opener when a closer is shown. Covers brace and indentation languages (Python) via real syntactic spans; returns `null` for unrecognized languages or sources with syntax errors so callers can fall back to a lexical scan.
- Added a `nohup` shell builtin to the embedded `pi_shell`, shadowing the external `/usr/bin/nohup`. It runs its operand command and propagates that command's exit status (and reports `missing operand` / exit 125 with no operand), but deliberately does **not** mask `SIGHUP` or detach the child into a new session the way real `nohup` does. Agents reach for `nohup … &` assuming the shell is one-shot; in this persistent embedded shell that assumption is wrong and the only effect of real `nohup` was to leak background processes that outlived the host. The builtin keeps such commands as ordinary descendants so they are reaped with the host instead of surviving as orphans.

## [15.10.2] - 2026-06-08

### Added

- Added the `super` modifier to `matchesKey` / `parseKey` / `parseKittySequence`. Key identifiers may now include `super+` (anywhere in the modifier prefix), and Kitty CSI-u sequences whose modifier mask contains the super bit (8) — e.g. Ghostty's macOS Option+Backspace `ESC [127;11u` — are now recognised instead of dropped ([#2064](https://github.com/can1357/oh-my-pi/issues/2064)).

### Fixed

- Fixed the native `copyToClipboard` leaving the X11 clipboard empty on Linux even while the process kept running. arboard answers clipboard `SelectionRequest`s from a background thread that lives only as long as a `Clipboard` instance exists, and the binding dropped its transient `Clipboard` immediately after `set_text` — tearing that thread down so the selection lost its owner and the clipboard read back empty (matching the `returned ok but clipboard=''` symptom). The Linux path now holds a single `Clipboard` for the lifetime of the process so the owner thread keeps serving, with no `xclip`/`wl-copy` subprocess; macOS/Windows keep the transient write on the calling thread ([#2075](https://github.com/can1357/oh-my-pi/issues/2075)).

## [15.10.1] - 2026-06-07

### Fixed

- Fixed `applyBashFixups` corrupting commands that contain multi-byte UTF-8 before a trailing `| head`/`| tail` (or `2>&1`). `brush-parser` reports source positions as Unicode-scalar (char) offsets, but `pi_shell::fixup` sliced the command `&str` by those numbers as if they were byte offsets, so each multi-byte char (e.g. `✓`/`×` in a `grep -E` pattern) shifted the cut earlier and left a mangled command — e.g. `… |✓|×|XCTAssert" | tail -80` became `… |✓|×-80`, orphaning the closing quote and making the shell reject the whole pipeline with `unterminated double quote`. Positions are now translated to byte offsets before slicing.

## [15.9.0] - 2026-06-04

### Fixed

- Bounded sorted `glob()` scans to `maxResults` during uncached traversal and emitted `onMatch` callbacks only for entries admitted to the bounded top-`maxResults` heap so broad OMP `find` progress and timeout partials stay consistent with the returned mtime-ranked set while keeping parent-process memory bounded ([#1761](https://github.com/can1357/oh-my-pi/issues/1761)).
- Fixed `wrapTextWithAnsi` hanging (infinite loop) on text containing a BEL-terminated string escape — DCS/SOS/PM/APC (`ESC P`/`ESC X`/`ESC ^`/`ESC _`) closed by `BEL` instead of `ST`. `ansi_seq_len_u16` only accepted the `ST` (`ESC \`) terminator for these (OSC already accepted both), so a BEL-terminated APC such as the TUI cursor marker (`ESC _ pi:c BEL`) was left unclassified: it was miscounted as visible width and `break_long_word`'s non-ESC scan could not advance past the `ESC`, spinning forever. The terminator set now matches OSC (ST **or** BEL), and `break_long_word` defensively emits and steps over any escape it cannot classify so a malformed/unknown sequence can never wedge the wrap loop.

## [15.7.0] - 2026-05-31

### Added

- Added `blockRangeAt` native API along with `BlockRange` and `BlockRangeOptions` types to return the 1-indexed line span of the outermost tree-sitter node beginning on a given line

### Fixed

- Fixed an interactive shell inside a **pipeline** (`zsh -i ... | awk`, `time zsh -i | cat`, etc.) suspending the embedded host with `suspended (tty input)`. The earlier embedded-host fix `setsid`-detached external children so they could not seize the host's controlling tty, but carved pipeline stages out because a later stage that `setpgid`-joined a detached leader failed with EPERM — leaving every pipeline stage in the host session, where an interactive child opened `/dev/tty`, `tcsetpgrp`'d itself to the foreground, and stopped the host (OMP) on its next tty read. `pi_shell` now detaches pipeline stages too: `child_session_action` returns `DetachSession` for any non-terminal-stdin child regardless of pipeline membership, and `execute_external_command` skips `process_group(...)` entirely for detached children so no cross-session `setpgid` is attempted. Pipeline stages no longer share one process group, which the embedded host does not rely on (cancellation walks the descendant tree and pipes are session-independent).

## [15.6.0] - 2026-05-30

### Changed

- Changed npm publishing to ship `@oh-my-pi/pi-natives` as a small core loader package plus per-platform optional dependency leaf packages, so installs fetch only the host platform's native addon instead of every supported `.node` binary.

## [15.5.10] - 2026-05-28

### Fixed

- Fixed background bash jobs pinning the JS main thread at ~200% CPU when the child process emits output in many tiny writes (printf-style progress, llama-cli token streams). `pi_shell`'s pipe reader forwarded every chunk through a separate `ThreadsafeFunction::call` per kernel `read(2)`, so a chatty child produced millions of cross-thread napi callbacks that the JS main thread had to drain serially — even after the child exited, the queue kept the process saturated for seconds. The bridge now greedily coalesces every chunk already in the mpsc queue into a single batched call (capped at 64 KiB) before crossing into JS, collapsing 1-byte writes into one napi dispatch and bringing the steady-state callback rate back to the JS event-loop's throughput.

## [15.5.9] - 2026-05-28

### Changed

- Changed native addon extraction to skip re-extracting cached `.node` files when their size already matches embedded archive metadata
- Changed standalone binaries to embed native addons as a compressed tarball and unpack them into the versioned native cache on first run instead of embedding each `.node` file uncompressed.

### Fixed

- Fixed CI native addon builds retaining ELF debug and symbol sections in release artifacts; stripped builds are now verified to reject `.debug_*`, `.zdebug_*`, `.symtab`, and `.strtab` sections.

### Security

- Hardened embedded addon archive extraction by rejecting unsafe entry names and non-file archive entries before writing binaries to disk

## [15.5.4] - 2026-05-27

### Added

- Added `Hashline` class with methods to format headers, parse/apply hashline edits, split inputs, compute diffs, generate previews, and recover from stale hashes
- Added `HashlineChunker` class to stream UTF-8 text into numbered hashline chunks incrementally
- Added `HashlineCursorKind`, `HashlineEditKind`, and `HashlineTokenKind` exports for hashline cursor/edit/token discrimination
- Added `unfoldUntilLines` and `unfoldLimitLines` options to `SummaryOptions` to control BFS unfold visibility with an optional hard cap

## [15.5.0] - 2026-05-26

### Fixed

- Fixed bash heredocs (`<<`) and here-strings (`<<<`) deadlocking the shell on Windows past ~4 KiB and on macOS past 16-64 KiB. `brush_core::interp::setup_open_file_with_contents` wrote the entire body into an anonymous pipe synchronously before handing the reader to the next command; once the body exceeded the OS pipe buffer the writer blocked forever and the `bash` tool timed out at the hard 305 s ceiling without ever launching the consumer. The Linux fast path still uses `F_SETPIPE_SZ` to grow the pipe in-place; every other OS-threaded platform (and Linux bodies above `pipe-max-size`) now decouples the write onto a fire-and-forget thread that terminates naturally on drain or `BrokenPipe`; no-thread targets keep the upstream synchronous path so heredocs do not fail at thread spawn.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey` claiming `ctrl+m`/`ctrl+j`/`ctrl+i`/`ctrl+h`/`ctrl+[` for the single bytes terminals emit for Enter/Tab/Backspace/Escape in legacy mode. Pressing Enter no longer triggers a `ctrl+m` binding; the named keys now own those bytes and the colliding `ctrl+<letter>` combinations only match when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. The same gate now also applies to `ctrl+alt+<letter>` legacy `ESC + <ctrl-char>` sequences (e.g. `\x1b\r` is Alt+Enter, not Ctrl+Alt+M). ([#1354](https://github.com/can1357/oh-my-pi/issues/1354))

## [15.0.2] - 2026-05-15

### Added

- Added a per-release version sentinel napi export (`__piNativesV{major}_{minor}_{patch}`). The Rust `js_name` is bumped in lock-step with the package version by `scripts/release.ts`; the JS loader computes the expected name from `package.json#version` and throws an actionable error when the on-disk `.node` doesn't expose it. This converts the silent `<sym> is not a function` crash from a stale addon into a load-time failure pointing at the real fix.
- Added `applyBashFixups(command)` — a synchronous brush-parser-driven rewrite that strips trailing `| head|tail …`, redundant `2>&1`, and the `|&` shorthand from top-level pipelines, returning `{ command, stripped }`. Replaces the hand-rolled top-level mask scanner in `pi-coding-agent`; tokenization, quoting, heredocs, command substitution, and nested compound commands are now handled by the real shell AST instead of regex/character-walking. Lives in `pi_shell::fixup` on the Rust side.

### Fixed

- Fixed `<sym> is not a function` crashes on Windows after `bun install -g @oh-my-pi/pi-coding-agent` updates while an `omp` process was running. Bun cannot overwrite a locked `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` and silently keeps the old binary alongside the new ESM wrapper, so the next launch loads mismatched code. The loader now mirrors the addon into `~/.omp/natives/<version>/` on Windows npm installs and prefers that copy at load time — each version gets its own filesystem path, so future updates land in `node_modules` unchallenged. The new version sentinel detects any remaining drift up front.
- Fixed `$env:NAME` PowerShell references being collapsed to `:NAME` when brush forwarded a command to a PowerShell (or any) subprocess. `pi-shell` now defines `env=$env` as a non-exported global on every brush session so the bash parameter expansion of `$env` yields the literal `$env`, leaving `$env:NAME` intact. User-driven assignments (`env=prod`) push their own command-scope binding and shadow the fallback, preserving the bash POSIX contract. ([#1079](https://github.com/can1357/oh-my-pi/issues/1079))

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun runtime version to >=1.3.14
- Removed `PhotonImage` class, `ImageFormat` enum, and `SamplingFilter` enum from native exports. General-purpose image decode/resize/encode now uses [`Bun.Image`](https://bun.com/docs/runtime/image), which ships in Bun 1.3.14+ with statically-linked libjpeg-turbo, libspng, and libwebp plus SIMD geometry kernels — same operations, zero native-addon footprint. `encodeSixel` stays (no Bun equivalent for the SIXEL terminal protocol).
- Removed `webp` Rust workspace dependency along with `PhotonImage`'s WebP encoder.

## [14.9.9] - 2026-05-12

### Breaking Changes

- Removed `projfsOverlayProbe`, `projfsOverlayStart`, and `projfsOverlayStop` overlays APIs and `ProjfsOverlayProbeResult` type from the public natives interface

### Added

- Added unified isolation APIs `isoBackend`, `isoProbe`, `isoResolve`, `isoStart`, `isoStop`, `isoDiff`, and `isoIsUnavailableError` for selecting, probing, resolving, starting, stopping, and diffing isolated filesystems
- Added `IsoBackendKind`, `IsoChangeKind`, `IsoDiff`, `IsoFileChange`, `IsoProbeResult`, and `IsoResolveResult` type exports to describe isolation backend capabilities and diff outcomes

### Changed

- Changed `native` exports to remove the platform-specific ProjFS-only overlay surface in favor of generic isolation controls

## [14.9.5] - 2026-05-12

### Fixed

- Fixed shell cancellation occasionally killing the harness. The `pi_shell` descendant tracker harvested every descendant's `pgid` into the kill set, so any subprocess that inherited the harness's pgid (any helper spawned via APIs that do not call `setpgid` — sibling LSP/MCP processes, etc.) dragged `harness.pgid` into the list and the follow-up `kill(-harness.pgid, SIGTERM)` terminated the harness alongside the targets. The classifier now only adopts a `pgid` when its leader is itself one of the new descendants, and `kill_process_group` refuses the harness's own process group as a last-line defense.
- Fixed macOS process-tree termination silently doing nothing. The descendant walk relied on `proc_listchildpids`, which on recent darwin kernels (25.4+) returns no entries when a process queries its own children, so `Process::descendants` came back empty and tree-kill cleanup never reached grandchildren. The walk now builds a one-shot `ppid → [pid]` map from `proc_listallpids` + `proc_pidinfo`, matching the approach already used by `find_by_path` and the Windows Toolhelp path.

### Changed

- Removed the 20 Hz background descendant tracker that scanned the harness's process tree for the entire lifetime of every shell command. Cancellation now does a small rescan-and-signal loop on demand (up to three waves — SIGTERM, then SIGKILL, then SIGKILL — with early exit as soon as no descendants remain). The previous tracker existed to pin process identities against PID reuse races, but `Process::from_pid` already pins identity by kernel start time / pidfd, so the constant scanning paid for nothing and added meaningful syscall load on macOS where each scan now does `proc_listallpids` + `proc_pidinfo` per pid.

## [14.9.3] - 2026-05-10

### Added

- Added `idle`, `system`, and `user` options to `MacOSPowerAssertion` so callers can request specific macOS sleep-prevention modes (`caffeinate -i`, `-s`, and `-u`) in addition to the existing `display` option
- Added support for combining multiple macOS power assertion flags in a single `MacOSPowerAssertion` handle

### Changed

- Changed `MacOSPowerAssertion.stop()` documentation to indicate it releases all held assertions and is safe to call repeatedly as a no-op

## [14.9.2] - 2026-05-10

### Added

- Added `listWorkspace`, a native single-pass workspace walker that returns bounded tree entries and AGENTS.md directory-context candidates together.

## [14.7.1] - 2026-05-06

### Added

- Added `size` property to `GlobMatch` for regular files to expose their byte size

### Changed

- Sped up native `grep` files-with-matches searches by stopping after the first match per file, reading small files without mmap overhead, and relying on grep-searcher binary detection instead of a separate full-file NUL scan.

### Fixed

- Fixed native `grep` `filesWithMatches` mode so `totalMatches` reports the number of matching files rather than line-match totals
- Fixed native `grep` count-mode limits applying to files instead of matches, and restored timeout/abort cancellation checks for small native filesystem scans.

## [14.7.0] - 2026-05-04

### Added

- Added `summarizeCode` function to expose native code summarization with `kind`, `startLine`, `endLine`, and optional `text` segments plus parse/elision metadata
- Added `minBodyLines` and `minCommentLines` options to `summarizeCode` to control when function/body and multiline comment elision is applied
- Added `SummaryOptions` and `SummaryResult` TypeScript definitions for typed `summarizeCode` input and output

## [14.6.1] - 2026-05-02

### Changed

- Changed the native package loader from CommonJS analyzer-visible assignments to a template-rendered ESM entry point with explicit named exports

## [14.5.13] - 2026-05-01

### Changed

- Stopped overriding `CARGO_TARGET_DIR` with an internal `target/napi-build/...` directory during native builds, so Cargo now uses the default or caller-provided target directory
- Simplified native build profile suffix formatting without changing `local` and `ci` values
- Changed the native build output behavior to avoid setting an isolated Cargo target directory automatically

### Removed

- Removed the host Zig CPU contract wrapper (`zig-safe-wrapper.ts`) and its `ZIG`/`PI_NATIVE_REAL_ZIG`/`PI_NATIVE_ZIG_TARGET`/`PI_NATIVE_ZIG_CPU` env handling, since the `zlob` Rust dependency that required Zig is gone
- Removed the `ci-release-verify-natives` script and its AVX-512 marker scan from the release pipeline

## [14.5.12] - 2026-04-30

### Breaking Changes

- Changed `waitForExit` to accept a single options object instead of a numeric timeout argument

### Added

- Added a `signal` option to `terminate` for cancelling termination while waiting for process shutdown
- Added abort `signal` support to `waitForExit` via `ProcessWaitOptions`
- Added a `ProcessWaitOptions` type and updated `waitForExit` to accept an options object

## [14.5.9] - 2026-04-30

### Fixed

- Fixed shell minimizer output so successful commands whose noise is fully stripped still return `OK` instead of an artifact-only result

## [14.5.6] - 2026-04-29

### Added

- Added shell minimizer support for CMake, CTest, Ninja, GoogleTest binaries, and Bun/Bunx wrappers that run those tools

## [14.5.2] - 2026-04-26

### Changed

- Changed local native build profile from `dev` to `local` for non-CI builds, updating the profile used by the build and local build output label

## [14.4.2] - 2026-04-26

### Removed

- Removed the `chunk` napi module (`ChunkState`, chunk schema, chunk rendering, chunk edit) and dropped `generate_chunk_schema()` from the build script

## [14.3.0] - 2026-04-25

### Added

- Added `text` to `MinimizerResult` so consumers can replace rewritten output with the minimized replacement text
- Added `settingsHash` to `MinimizerOptions` to verify the minimizer `settingsPath` contents against a xxHash64 digest before applying them
- Added `minimized` output telemetry via `MinimizerResult` on `ShellExecuteResult` and `ShellRunResult`, exposing the applied minimizer filter and original/minimized byte counts when output is rewritten
- Added a new `minimizer` option to `ShellExecuteOptions` and `ShellOptions` to configure per-command output minimization
- Added the `MinimizerOptions` API with controls for enabling minimization, overriding settings via `settingsPath`, allow/deny lists (`only`, `except`), and `maxCaptureBytes` capture limits

### Changed

- Changed the shell output minimizer to more aggressively compact successful test runs, git output, large listings, grep/find results, source reads, and dependency manifests
- Changed compound and piped shell commands to bypass output minimization entirely, keeping minimization limited to eligible whole-command output after the command exits

### Fixed

- Fixed chunk edit batches so later operations can reuse an initially validated checksum after an earlier operation changes that same chunk

### Removed

- Removed `PI_DEV` loader diagnostic env var and associated console logging in the native addon loader

### Security

- Added trust-gated loading for minimizer settings by requiring a matching `settingsHash` before accepting a settings file

## [14.2.0] - 2026-04-23

### Added

- Added Dart support to `astGrep` and `astEdit` through the native tree-sitter Dart grammar ([#748](https://github.com/can1357/oh-my-pi/pull/748) by [@0fflineuser](https://github.com/0fflineuser))

## [14.1.1] - 2026-04-14

### Added

- Added support for honoring the `ZIG` environment variable when resolving the Zig executable for native builds

### Removed

- Removed the `SearchDb` API from the natives type declarations
- Removed the optional `db` parameter from `fuzzyFind`, `glob`, and `grep`
- Removed the `fuzzyFind`, `glob`, and `grep` cache database argument previously used for search state

## [14.0.5] - 2026-04-11

### Breaking Changes

- Made `tabWidth` parameter required (no longer optional) for `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments`
- Removed `getIndentation`, `getDefaultTabWidth`, and `setDefaultTabWidth` (moved to `@oh-my-pi/pi-utils`)
- `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments` now require an explicit `tabWidth` argument

## [14.0.4] - 2026-04-10

### Added

- Added `normalizeIndent` option to `EditParams` to control indentation normalization for response rendering and inserted content
- Added `hasConflicts()` method to detect unresolved merge conflicts in parsed files
- Added `conflictCount()` method to count unresolved merge conflicts in the chunk tree

## [14.0.2] - 2026-04-09

### Added

- Added `Decl` variant to `ChunkRegion` enum for accessing semantic declarations without leading trivia
- Added `check:types` script for explicit TypeScript type checking
- Added `lint` script for running Biome linter
- Added `fmt` script for code formatting with Biome
- Added package exports field with typed entry point configuration
- Added turbo.json configuration for build task caching and optimization

### Changed

- Renamed `build:native` script to `build` for simpler invocation
- Updated `check` script to separately call `check:types` for type checking
- Modified tsconfig.json to extend `tsconfig.workspace.json` instead of `tsconfig.base.json`

Older entries are archived in [packages/natives/CHANGELOG.md@2de014179b6a](https://github.com/cybermonklabs/oh-my-pi/blob/2de014179b6a9a8b0842663752cb9e804687dc62/packages/natives/CHANGELOG.md).
