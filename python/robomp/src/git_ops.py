"""Low-level git primitives with ephemeral PAT injection.

The PAT is supplied through `git --config-env=http.<url>.extraHeader=ENVVAR`
when a verified HTTPS remote is known, or the legacy global `http.extraHeader`
path for older direct callers. Git expands the env var inside the spawned
process; the secret never appears in argv visible to other UIDs via
`/proc/<pid>/cmdline`.

Used by:
- `robomp.sandbox.LocalGitTransport` for in-process git operations when no
  proxy is configured.
- `robomp.proxy.server` for proxied operations on the gh-proxy side.
"""

from __future__ import annotations

import base64
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger(__name__)

# Per-call env var name. `git --config-env` reads the header value from this
# env entry inside the spawned process — never persisted into `.git/config`.
AUTH_ENV_VAR = "ROBOMP_GIT_HTTP_AUTH"
_TOKEN_ALLOWED_PROTOCOLS = "https"
_TOKEN_SAFE_CONFIG = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.http.allow=never",
    "protocol.git.allow=never",
    "protocol.ssh.allow=never",
    "protocol.file.allow=never",
    "protocol.ext.allow=never",
    "credential.helper=",
    "core.askPass=",
    "core.hooksPath=/dev/null",
    "http.proxy=",
    "http.sslVerify=true",
    "http.extraHeader=",
]
_GIT_SUBPROCESS_SCRUBBED_ENV_KEYS = (
    AUTH_ENV_VAR,
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBOMP_REPLAY_TOKEN",
    "ROBOMP_GH_PROXY_HMAC_KEY",
)


def _git_subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in _GIT_SUBPROCESS_SCRUBBED_ENV_KEYS:
        env.pop(key, None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = ""
    env["SSH_ASKPASS"] = ""
    return env


# git matches `http.<url>.*` / `credential.<url>.*` against the FULL request
# URL, and the longest path-prefix wins — so a base-only override loses to an
# agent-planted repo-local key like `http.<url>/info/refs.proxy=http://evil`,
# which would route the token-bearing fetch through an attacker proxy and read
# the injected Authorization header. Override every git smart-HTTP request path
# the fetch/push can actually hit. The set is exhaustive: a repo-local key
# longer than the real request path can't match it, and `GIT_CONFIG_SYSTEM`/
# `GLOBAL` are already nulled, so repo-local `.git/config` is the only competing
# source. We blank `proxy` and force `sslVerify=true` — no proxy plus verified
# TLS leaves no interception point, so the PAT can't be captured — and blank
# `credential.helper` (a forced 401 would otherwise run a repo-configured
# `!cmd` helper with the PAT still in the environment). We deliberately do NOT
# touch `sslCAInfo`/`sslCAPath`: blanking them makes libcurl fail with "error
# setting certificate verify locations" before any TLS, breaking every real
# github fetch; and with the proxy neutralized an attacker-set CA only yields a
# self-inflicted fetch failure, never interception. `extraHeader` is blanked
# only at the base — the real header is injected right after via `--config-env`,
# and a path-scoped blank would strip it (auth failure).
_GIT_SMART_HTTP_PATHS = ("", "/info", "/info/refs", "/git-upload-pack", "/git-receive-pack")


def _token_url_safe_config(auth_url: str | None) -> list[str]:
    if auth_url is None:
        return []
    items: list[str] = []
    for suffix in _GIT_SMART_HTTP_PATHS:
        scoped = f"{auth_url}{suffix}"
        items += [
            f"http.{scoped}.proxy=",
            f"http.{scoped}.sslVerify=true",
            f"credential.{scoped}.helper=",
        ]
    items.append(f"http.{auth_url}.extraHeader=")
    return items


def _http_extra_header_key(auth_url: str | None) -> str:
    if auth_url is None:
        return "http.extraHeader"
    return f"http.{auth_url}.extraHeader"


_CRED_URL = re.compile(r"(https?://)([^:/@\s]+):([^@/\s]+)@")
_BAD_OBJECT_REF_RE = re.compile(
    r"(?:fatal: bad object (?P<bad>refs/[^\s]+)|error: (?P<invalid>refs/[^\s]+) does not point to a valid object!)"
)
_FETCH_PRUNE_REPAIR_ATTEMPTS = 8

_SHARED_OMP_GID = 2000
_AGENT_HOME = Path("/srv/agent-home")


def _slot_permissions_active(slot_uid: int | None) -> bool:
    return slot_uid is not None and platform.system() == "Linux" and os.geteuid() == 0


def _slot_subprocess_kwargs(slot_uid: int | None) -> dict[str, Any]:
    if not _slot_permissions_active(slot_uid):
        return {}
    assert slot_uid is not None
    return {"user": slot_uid, "group": slot_uid, "extra_groups": [_SHARED_OMP_GID], "umask": 0o002}


_GIT_CONFIG_SLOT_RE = re.compile(r"GIT_CONFIG_(?:KEY|VALUE)_(\d+)")


def _is_git_config_series_key(name: str) -> bool:
    return name == "GIT_CONFIG_COUNT" or _GIT_CONFIG_SLOT_RE.fullmatch(name) is not None


def _git_config_series(env: Mapping[str, str]) -> list[tuple[str, str]]:
    """The `GIT_CONFIG_COUNT`/`KEY_<n>`/`VALUE_<n>` entries git reads from ``env``, in order."""
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    return [(env.get(f"GIT_CONFIG_KEY_{i}", ""), env.get(f"GIT_CONFIG_VALUE_{i}", "")) for i in range(count)]


def _append_git_config(env: dict[str, str], key: str, value: str) -> None:
    """Add ``key=value`` after the `GIT_CONFIG_*` series ``env`` already carries.

    Every inherited entry (a caller's own git config) keeps its slot and the new
    one takes the next. Any slot ``env`` holds past the new count is dropped, so
    no stale entry is left for git or a later append to read.
    """
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    env[f"GIT_CONFIG_KEY_{count}"] = key
    env[f"GIT_CONFIG_VALUE_{count}"] = value
    env["GIT_CONFIG_COUNT"] = str(count + 1)
    for name in [name for name in env if (slot := _GIT_CONFIG_SLOT_RE.fullmatch(name)) and int(slot[1]) > count]:
        del env[name]


def _append_safe_directory(env: dict[str, str], repo_dir: Path) -> None:
    _append_git_config(env, "safe.directory", str(repo_dir))


def _is_inherited_git_config_key(name: str) -> bool:
    """A variable that hands git config to a child: the `GIT_CONFIG_*` series or `GIT_CONFIG_PARAMETERS`."""
    return name == "GIT_CONFIG_PARAMETERS" or _is_git_config_series_key(name)


def _replace_git_config_with_safe_directory(env: dict[str, str], repo_dir: Path) -> None:
    """Leave ``safe.directory=<repo_dir>`` as the only git config ``env`` hands a child.

    For the commands that run code from the checkout: robomp's own series and
    `GIT_CONFIG_PARAMETERS` can carry a credential helper or an
    `http.extraHeader`, which must not reach them.
    """
    for name in [name for name in env if _is_inherited_git_config_key(name)]:
        del env[name]
    _append_safe_directory(env, repo_dir)


def _safe_directory_overlay(base: Mapping[str, str], repo_dir: Path) -> dict[str, str]:
    """Overlay that leaves ``safe.directory=<repo_dir>`` as the only git config once merged over ``base``.

    For the agent's env, which omp_rpc assembles as ``{**base, **overlay}``: the
    agent runs code from the checkout, so robomp's own series and
    `GIT_CONFIG_PARAMETERS` (a credential helper, an `http.extraHeader`) must
    not reach it. An overlay cannot remove a key, so each inherited one is
    blanked; git reads no slot past the count and no config from an empty
    `GIT_CONFIG_PARAMETERS`.
    """
    overlay = dict.fromkeys((name for name in base if _is_inherited_git_config_key(name)), "")
    overlay.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "safe.directory", "GIT_CONFIG_VALUE_0": str(repo_dir)})
    return overlay


def _operator_config_overlay(base: Mapping[str, str], agent_home: Path | None) -> dict[str, str]:
    """Overlay that keeps robomp's operator's config from a process that runs code from the checkout.

    Git reads a global config file, a system one and `$XDG_CONFIG_HOME/git/
    config`, and other tools (gh, lspmux, …) read `$XDG_CONFIG_HOME` too; any
    of them can carry a credential helper or a token. Merged over ``base``
    (robomp's env) after the slot runtime env, which points `XDG_CONFIG_HOME`
    at the workspace's own empty config dir:

    - with no agent home the process keeps robomp's HOME, so git reads an empty
      global file instead of the operator's `~/.gitconfig`;
    - with an agent home both name that home's own files, as its HOME would,
      whatever `GIT_CONFIG_GLOBAL` or `XDG_CONFIG_HOME` ``base`` sets;
    - a `GIT_CONFIG_SYSTEM` file that ``base`` names is not read
      (`GIT_CONFIG_NOSYSTEM`); the machine's own system config still is.
    """
    overlay = {"GIT_CONFIG_GLOBAL": os.devnull if agent_home is None else str(agent_home / ".gitconfig")}
    if agent_home is not None:
        overlay["XDG_CONFIG_HOME"] = str(agent_home / ".config")
    if "GIT_CONFIG_SYSTEM" in base:
        overlay["GIT_CONFIG_NOSYSTEM"] = "1"
    return overlay


def _local_remote_safe_directory(remote_url: str, *, cwd: Path) -> Path | None:
    """Return a local filesystem remote path that git may need whitelisted."""
    raw = remote_url.strip()
    if not raw:
        return None
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.netloc not in ("", "localhost"):
            return None
        return Path(parsed.path)
    if "://" in raw or re.match(r"^[^/\\s]+:", raw):
        return None
    path = Path(raw)
    return path if path.is_absolute() else (cwd / path).resolve()


def redact_credentials(text: str | None) -> str:
    """Strip `user:password@` from any embedded URL in `text`."""
    if not text:
        return text or ""
    return _CRED_URL.sub(r"\1***@", text)


def _redacted_cmd(cmd: list[str]) -> list[str]:
    return [redact_credentials(part) for part in cmd]


class GitCommandError(RuntimeError):
    """Wraps a failed git subprocess with credentials redacted from argv and stderr."""

    def __init__(self, cmd: list[str], returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = redact_credentials(stdout)
        self.stderr = redact_credentials(stderr)
        self.cmd = _redacted_cmd(cmd)
        msg = self.stderr.strip() or self.stdout.strip() or f"exit {returncode}"
        super().__init__(f"git {' '.join(self.cmd[1:])} failed: {msg}")


def _basic_auth_header(token: str) -> str:
    """Build the `Authorization: Basic …` header value for a PAT.

    GitHub accepts `x-access-token:<PAT>` over HTTPS Basic auth; that form
    works for fine-grained tokens, classic PATs, and GitHub App installation
    tokens alike.
    """
    raw = f"x-access-token:{token}".encode()
    return f"Authorization: Basic {base64.b64encode(raw).decode('ascii')}"


_DEFAULT_GIT_TIMEOUT_SECONDS = 120.0
"""Hard wall-clock cap on any one `git` invocation. Overridable per-call.

A hung child (auth prompt, network stall, server-side packfile generation
that never finishes) MUST NOT pin the calling thread forever — especially
when the gh-proxy invokes `_run_git` from an executor and bounds its OWN
wait via `asyncio.wait_for`. The asyncio bound returns control to the
event loop, but only this `timeout=` + kill below frees the OS process.
"""


def _run_git(
    args: list[str],
    *,
    cwd: Path | None,
    token: str | None,
    auth_url: str | None = None,
    extra_env: Mapping[str, str] | None = None,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
    timeout: float | None = None,
    input: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `git <args>` with optional PAT injection via `--config-env`.

    When `auth_url` is supplied, the PAT header is scoped to that exact
    HTTPS URL (`http.<url>.extraHeader`) and git is restricted to the HTTPS
    transport. That keeps a token-bearing invocation from handing the header
    to another host, following `url.*.insteadOf` to `ext::`/ssh/file helpers,
    or running workspace hooks with the token in the environment.

    The inherited `GIT_CONFIG_*` series (the caller's own git config) is kept;
    the entries of an `extra_env` series and then `safe_directory` are appended
    after it rather than written over its slots.

    A returncode of 0 returns the populated `CompletedProcess`. Non-zero exit
    returns the same shape; callers either `_check` it or inspect manually
    (e.g. when probing for ref existence). Stdout/stderr are always
    credential-redacted before being returned.
    """
    env = _git_subprocess_env()
    if user is not None and _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    if extra_env:
        env.update({name: value for name, value in extra_env.items() if not _is_git_config_series_key(name)})
        for key, value in _git_config_series(extra_env):
            _append_git_config(env, key, value)
    if safe_directory is not None:
        _append_safe_directory(env, safe_directory)

    cmd: list[str] = ["git", "-c", "protocol.ext.allow=never"]
    if token:
        env[AUTH_ENV_VAR] = _basic_auth_header(token)
        if auth_url is not None:
            env["GIT_ALLOW_PROTOCOL"] = _TOKEN_ALLOWED_PROTOCOLS
            env["GIT_CONFIG_NOSYSTEM"] = "1"
            env["GIT_CONFIG_SYSTEM"] = os.devnull
            env["GIT_CONFIG_GLOBAL"] = os.devnull
            for item in [*_TOKEN_SAFE_CONFIG, *_token_url_safe_config(auth_url)]:
                cmd.extend(["-c", item])
        cmd.extend(["--config-env", f"{_http_extra_header_key(auth_url)}={AUTH_ENV_VAR}"])
    cmd.extend(args)
    log.debug("git", extra={"cmd": _redacted_cmd(cmd), "cwd": str(cwd) if cwd else None})
    effective_timeout = _DEFAULT_GIT_TIMEOUT_SECONDS if timeout is None else timeout
    subprocess_kwargs: dict[str, Any] = {}
    if user is not None:
        subprocess_kwargs["user"] = user
    if group is not None:
        subprocess_kwargs["group"] = group
    if extra_groups is not None:
        subprocess_kwargs["extra_groups"] = extra_groups
    if umask is not None:
        subprocess_kwargs["umask"] = umask
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
            input=input,
            **subprocess_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        # `subprocess.run` already kills the direct child when the timeout
        # fires, but we explicitly re-raise as `GitCommandError` so callers
        # don't have to special-case `TimeoutExpired` alongside the regular
        # non-zero-exit error path. 124 mirrors GNU `timeout`.
        stdout = redact_credentials(exc.stdout or "") if isinstance(exc.stdout, str) else ""
        stderr_msg = f"git timed out after {effective_timeout:.0f}s: {' '.join(_redacted_cmd(cmd))}"
        raise GitCommandError(cmd, 124, stdout, stderr_msg) from exc
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _check(proc: subprocess.CompletedProcess[str], cmd: list[str]) -> subprocess.CompletedProcess[str]:
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def _git_dir(repo_dir: Path) -> Path | None:
    dot_git = repo_dir / ".git"
    if dot_git.is_dir():
        return dot_git
    if dot_git.is_file():
        try:
            text = dot_git.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        prefix = "gitdir:"
        if not text.startswith(prefix):
            return None
        git_dir = Path(text[len(prefix) :].strip())
        return git_dir if git_dir.is_absolute() else (repo_dir / git_dir).resolve()
    if (repo_dir / "HEAD").exists() and (repo_dir / "objects").is_dir():
        return repo_dir
    return None


def _resolve_alternate_path(objects_dir: Path, raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return (objects_dir / path).resolve()


def _prune_missing_alternates(repo_dir: Path) -> bool:
    """Drop object alternates that point at directories no longer mounted.

    The bot never configures alternates for pool clones. If one leaks in from
    an external git invocation and points at a temp directory, every later
    fetch emits warnings and refs whose objects lived only there become
    unreadable. Removing the dead alternate lets the repair path below delete
    those broken refs and recover the pool without recloning it.
    """
    git_dir = _git_dir(repo_dir)
    if git_dir is None:
        return False
    objects_dir = git_dir / "objects"
    alternates = objects_dir / "info" / "alternates"
    try:
        lines = alternates.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return False

    kept: list[str] = []
    changed = False
    for line in lines:
        raw = line.strip()
        if not raw:
            changed = True
            continue
        if _resolve_alternate_path(objects_dir, raw).is_dir():
            kept.append(line)
        else:
            changed = True

    if not changed:
        return False
    try:
        if kept:
            alternates.write_text("\n".join(kept) + "\n", encoding="utf-8")
        else:
            alternates.unlink()
    except OSError as exc:
        log.warning("failed to prune missing git alternates", extra={"repo_dir": str(repo_dir), "error": str(exc)})
        return False
    log.warning("pruned missing git alternates", extra={"repo_dir": str(repo_dir)})
    return True


def _is_safe_ref_name(ref: str) -> bool:
    if not ref.startswith("refs/"):
        return False
    if any(ch in ref for ch in "\0\r\n\t "):
        return False
    return all(part not in ("", ".", "..") for part in ref.split("/"))


def _bad_refs_from_fetch_output(output: str) -> tuple[str, ...]:
    refs: list[str] = []
    seen: set[str] = set()
    for match in _BAD_OBJECT_REF_RE.finditer(output):
        ref = match.group("bad") or match.group("invalid") or ""
        if ref in seen or not _is_safe_ref_name(ref):
            continue
        seen.add(ref)
        refs.append(ref)
    return tuple(refs)


def _worktrees_holding_refs(repo_dir: Path, refs: tuple[str, ...]) -> dict[str, list[str]]:
    """Map each ref in ``refs`` to the linked worktrees whose ``HEAD`` is on it.

    A worktree that has the soon-to-be-deleted branch checked out keeps a
    stale ``HEAD`` pointer after ``update-ref -d`` succeeds in the shared
    refs store. The next ``git fetch`` then re-reports the same "bad object"
    error because git inspects every worktree's ``HEAD`` for connectivity.
    Removing the offending worktree clears that pointer so the fetch can
    recover.

    Each `worktrees/<id>` entry's `HEAD` is read as it stands, with no listing
    parsed, so one oddly named entry cannot stop the repair; the pool's own
    (main) worktree is never one of them. A path is the worktree's resolved
    path (see `_registered_worktrees`).
    """
    if not refs:
        return {}
    refs_set = set(refs)
    by_ref: dict[str, list[str]] = {}
    for entry, worktree in _registered_worktrees(repo_dir):
        ref = _head_ref(entry)
        if ref in refs_set:
            by_ref.setdefault(ref, []).append(worktree)
    return by_ref


def _head_ref(entry: str) -> str | None:
    """The ref a `worktrees/<id>` entry's `HEAD` is on, or None (detached, or unreadable)."""
    try:
        head = os.fsdecode(Path(entry, "HEAD").read_bytes()).strip()
    except OSError:
        return None
    return head.removeprefix("ref: ") if head.startswith("ref: ") else None


def _real_path(path: str | Path) -> str:
    """``path`` made absolute, its parents resolved as the kernel walks them, its last part kept as is.

    `os.path.abspath` would drop `<link>/..` as text before resolving the
    link; the kernel and git resolve `<link>` first and go up from its target.
    """
    head, tail = os.path.split(os.path.join(os.getcwd(), path))
    return os.path.join(os.path.realpath(head), tail)


def _registered_worktrees(pool: Path) -> list[tuple[str, str]]:
    """`(entry, worktree)` for each `worktrees/<id>` entry of ``pool`` and the worktree it registers.

    Each entry's `gitdir` (`<worktree>/.git`, as git writes it) is read as
    bytes and its worktree resolved as git and the kernel resolve it. No
    listing is parsed and git does not run, so one unreadable, locked or oddly
    named entry cannot stop the others. An entry whose `gitdir` cannot be read
    or is relative (git 2.48's `worktree.useRelativePaths`) is left out. The
    git directory is resolved first, so an entry's path compares equal to the
    resolved path a checkout's `.git` file names.
    """
    git_dir = _git_dir(pool)
    if git_dir is None:
        return []
    git_dir = Path(os.path.realpath(git_dir))
    try:
        entries = list(os.scandir(git_dir / "worktrees"))
    except (FileNotFoundError, NotADirectoryError):
        return []
    registered: list[tuple[str, str]] = []
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        try:
            back = os.fsdecode(Path(entry.path, "gitdir").read_bytes().rstrip(b"\r\n"))
        except OSError:
            continue
        if not back.endswith("/.git") or not os.path.isabs(back):
            continue
        registered.append((entry.path, _real_path(back.removesuffix("/.git"))))
    return registered


def _dead_registrations(pool: Path, matches: Callable[[str], bool]) -> list[str]:
    """The `worktrees/<id>` entries of ``pool`` whose worktree is gone and whose resolved path ``matches``."""
    return [
        entry for entry, worktree in _registered_worktrees(pool) if not os.path.lexists(worktree) and matches(worktree)
    ]


def _drop_worktree_registration(checkout: Path, pool: Path, *, under: bool = False) -> None:
    """Delete ``pool``'s registrations of ``checkout`` once it is gone; with ``under``, of everything below it too.

    A failed remove or add leaves a registration behind, and it keeps holding
    its branch: the next add at that path, or of that branch, fails. Every dead
    entry whose worktree resolves to ``checkout`` is deleted, locked or not (a
    `git` wrapper on PATH may lock every `git worktree add`), and every live
    one, and every other dead one, is left alone. Nothing is deleted while
    anything is left at a registered path, and git never runs: it would follow
    a link left there into another worktree. Raises GitCommandError when an
    entry cannot be deleted; the others are deleted first.
    """
    target = _real_path(checkout)
    if not under and os.path.lexists(target):
        return
    prefix = target + os.sep
    failed: list[str] = []
    for admin in _dead_registrations(pool, lambda wt: wt == target or (under and wt.startswith(prefix))):
        try:
            shutil.rmtree(admin)
        except OSError as exc:
            failed.append(f"{admin}: {exc}")
    if failed:
        raise GitCommandError(["git", "worktree", "remove", str(checkout)], 1, "", "; ".join(failed))


def _checkout_registration(checkout: str) -> str | None:
    """The resolved `worktrees/<id>` entry the checkout at ``checkout`` points back to, or None.

    It is git's check before `git worktree remove`: ``checkout`` must be a
    real directory (not a link) holding a `.git` regular file that reads
    `gitdir: <entry>`. Anything else at the path is no linked worktree's
    checkout.
    """
    dot_git = os.path.join(checkout, ".git")
    try:
        if not stat.S_ISDIR(os.lstat(checkout).st_mode) or not stat.S_ISREG(os.lstat(dot_git).st_mode):
            return None
        with open(dot_git, "rb") as gitfile:
            text = gitfile.read(65536)
    except OSError:
        return None
    if not text.startswith(b"gitdir: "):
        return None
    return os.path.realpath(os.fsdecode(text.removeprefix(b"gitdir: ").strip()))


def _remove_worktrees(repo_dir: Path, paths: list[str], ref: str) -> None:
    """Remove the linked worktrees holding ``ref``, and drop their registrations.

    Any slot can write a registration naming any path, and robomp runs as
    root, so a path is removed only when it is the checkout of a registration
    holding ``ref``: a real directory whose `.git` file names that
    registration (`_checkout_registration`), and with no registration of the
    path locked. Then every dead registration at or under the path goes, a
    worktree nested in the checkout included. In every other case the path is
    left as it is and only the holding registrations are dropped, which
    clears the HEAD that blocks the fetch; a locked one, or the one the
    checkout there points back to, is kept. Git does not run: `git worktree
    remove` checks a path and opens it again to delete it. `shutil.rmtree`
    refuses a link swapped in for the checkout after the check; a link swapped
    in for a parent directory is not guarded. A checkout or registration that
    cannot be deleted raises GitCommandError, after the other paths are done:
    a registration left behind keeps holding the ref, and the next fetch fails
    the same way.
    """
    registered = _registered_worktrees(repo_dir)
    failed: list[str] = []
    for path in dict.fromkeys(paths):
        target = _real_path(path)
        entries = [entry for entry, worktree in registered if worktree == target]
        holders = {os.path.realpath(entry) for entry in entries if _head_ref(entry) == ref}
        if not holders:
            log.warning(
                "left a path no linked worktree on the bad ref registers during fetch repair",
                extra={"repo_dir": str(repo_dir), "worktree": target},
            )
            continue
        own = _checkout_registration(target)
        locked = any(os.path.lexists(os.path.join(entry, "locked")) for entry in entries)
        try:
            if own in holders and not locked:
                shutil.rmtree(target)
            if not os.path.lexists(target):
                _drop_worktree_registration(Path(target), repo_dir, under=True)
                log.warning(
                    "removed worktree during fetch repair",
                    extra={"repo_dir": str(repo_dir), "worktree": target},
                )
                continue
            for holder in holders - {own}:
                if not os.path.lexists(os.path.join(holder, "locked")):
                    shutil.rmtree(holder)
        except GitCommandError as exc:
            failed.append(exc.stderr)
            continue
        except OSError as exc:
            failed.append(f"{target}: {exc}")
            continue
        log.warning(
            "left a path that is no unlocked holding registration's checkout during fetch repair",
            extra={"repo_dir": str(repo_dir), "worktree": target},
        )
    if failed:
        raise GitCommandError(["git", "worktree", "remove", *paths], 1, "", "; ".join(failed))


def _delete_bad_refs(repo_dir: Path, output: str) -> bool:
    bad_refs = _bad_refs_from_fetch_output(output)
    if not bad_refs:
        return False
    holding = _worktrees_holding_refs(repo_dir, bad_refs)
    changed = False
    for ref in bad_refs:
        worktrees = holding.get(ref) or []
        if worktrees:
            _remove_worktrees(repo_dir, worktrees, ref)
            changed = True
        proc = _run_git(["update-ref", "-d", ref], cwd=repo_dir, token=None)
        if proc.returncode == 0:
            changed = True
            log.warning(
                "deleted invalid git ref during fetch repair",
                extra={"repo_dir": str(repo_dir), "git_ref": ref},
            )
            continue
        log.warning(
            "failed to delete invalid git ref during fetch repair",
            extra={"repo_dir": str(repo_dir), "git_ref": ref, "stderr": proc.stderr[:500]},
        )
    return changed


def _repair_fetch_prune_failure(repo_dir: Path, output: str) -> bool:
    pruned_alternates = _prune_missing_alternates(repo_dir)
    deleted_refs = _delete_bad_refs(repo_dir, output)
    return pruned_alternates or deleted_refs


def _explicit_remote_env(remote_url: str | None, *, cwd: Path) -> dict[str, str] | None:
    if remote_url is None:
        return None
    local_remote = _local_remote_safe_directory(remote_url, cwd=cwd)
    if local_remote is None:
        return None
    env: dict[str, str] = {}
    _append_safe_directory(env, local_remote)
    return env


def _branch_refspec(ref: str) -> str:
    if ":" in ref or ref.startswith("refs/") and not ref.startswith("refs/heads/"):
        return ref
    branch = ref.removeprefix("refs/heads/")
    return f"+refs/heads/{branch}:refs/remotes/origin/{branch}"


# ---------- Public primitives ----------


def clone(
    target: Path,
    *,
    clone_url: str,
    default_branch: str,
    token: str | None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Fresh `git clone --filter=blob:none` into `target`."""
    target.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "clone",
        "--filter=blob:none",
        "--no-tags",
        "--branch",
        default_branch,
        clone_url,
        str(target),
    ]
    _check(_run_git(args, cwd=None, token=token, auth_url=auth_url, safe_directory=safe_directory), ["git", *args])


def fetch_prune(
    repo_dir: Path,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Refresh `refs/remotes/origin/*` on the shared pool clone.

    When `remote_url` is supplied the fetch bypasses on-disk `origin` and uses
    an explicit branch refspec so checkout and push-lease logic still see
    fresh `refs/remotes/origin/*`.
    """
    _prune_missing_alternates(repo_dir)
    last_proc: subprocess.CompletedProcess[str] | None = None
    extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
    args = (
        ["fetch", "--prune", "origin"]
        if remote_url is None
        else [
            "fetch",
            "--prune",
            "--no-tags",
            "--filter=blob:none",
            remote_url,
            "+refs/heads/*:refs/remotes/origin/*",
        ]
    )
    for _ in range(_FETCH_PRUNE_REPAIR_ATTEMPTS):
        proc = _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=extra_env,
            safe_directory=safe_directory,
        )
        if proc.returncode == 0:
            return
        last_proc = proc
        output = f"{proc.stderr}\n{proc.stdout}"
        if not _repair_fetch_prune_failure(repo_dir, output):
            _check(proc, ["git", *args])
    assert last_proc is not None
    _check(last_proc, ["git", *args])


def _backfill_tip_blobs(
    repo_dir: Path,
    rev: str,
    remote: str,
    *,
    token: str | None,
    auth_url: str | None,
    extra_env: Mapping[str, str] | None,
    safe_directory: Path | None,
) -> subprocess.CompletedProcess[str] | None:
    """Fetch the blobs of ``rev``'s tree that the blob:none pool lacks.

    A checkout of ``rev`` then never needs a lazy promisor fetch, which in
    proxy-transport deployments runs in the orchestrator without a PAT and
    dies (oh-my-pi#1818). Only the tip tree is materialized, not ``rev``'s
    history, so the transfer is the files changed since the pool last saw
    them. Returns the fetch result, or ``None`` when nothing was missing.

    Raises ``GitCommandError`` if ``rev`` cannot be walked locally.
    """
    listing = ["rev-list", "--objects", "--missing=print", "--no-object-names", "-n1", rev]
    walked = _check(_run_git(listing, cwd=repo_dir, token=None, safe_directory=safe_directory), ["git", *listing])
    missing = [line[1:] for line in walked.stdout.splitlines() if line.startswith("?")]
    if not missing:
        return None
    # Same request git's own lazy fetch sends: explicit object ids (served
    # regardless of the filter), no negotiation, no ref updates.
    args = [
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
        remote,
    ]
    return _run_git(
        args,
        cwd=repo_dir,
        token=token,
        auth_url=auth_url,
        extra_env=extra_env,
        safe_directory=safe_directory,
        input="\n".join(missing) + "\n",
    )


def fetch_ref(
    repo_dir: Path,
    ref: str,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Fetch ``<ref>`` from origin AND materialize the blobs of its tree.

    Callers invoke this immediately before a ``git worktree add`` / checkout
    that needs the working-tree contents, so those blobs MUST be present after
    this returns. ``<repo_dir>`` is typically a ``--filter=blob:none`` partial
    clone, so the ref fetch itself brings commits and trees only;
    :func:`_backfill_tip_blobs` then fetches exactly the missing blobs of the
    tip. (An earlier ``--refetch --no-filter`` did the same job by re-downloading
    and re-indexing the ref's entire history on every call.) The on-disk
    partial-clone config is untouched, so ``fetch_prune`` stays cheap.

    Best-effort: a failure is logged and swallowed because the caller still
    attempts the checkout, and a stale-ref worktree add surfaces a more
    actionable error than this fetch ever could.
    """
    remote = remote_url or "origin"
    extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
    args = ["fetch", "--no-tags", remote, _branch_refspec(ref) if remote_url else ref]
    proc = _run_git(
        args,
        cwd=repo_dir,
        token=token,
        auth_url=auth_url,
        extra_env=extra_env,
        safe_directory=safe_directory,
    )
    if proc.returncode == 0:
        try:
            backfill = _backfill_tip_blobs(
                repo_dir,
                "FETCH_HEAD",
                remote,
                token=token,
                auth_url=auth_url,
                extra_env=extra_env,
                safe_directory=safe_directory,
            )
        except GitCommandError as exc:
            log.debug("fetch_ref blob backfill failed", extra={"ref": ref, "stderr": exc.stderr})
            return
        if backfill is None or backfill.returncode == 0:
            return
        proc = backfill
    log.debug(
        "fetch_ref non-fatal failure",
        extra={"ref": ref, "stderr": proc.stderr},
    )


_UNSAFE_REF_BODY_RE = re.compile(r"[\x00-\x20\x7f~^:?*\[\\]")


def validate_fetch_ref(ref: str) -> str:
    """Accept Git-valid branch names minus refspec/option-injectable characters."""
    body = ref.removeprefix("refs/heads/")
    if (
        not body
        or body.startswith(("-", "/"))
        or body.endswith(("/", ".", ".lock"))
        or "//" in body
        or ".." in body
        or "@{" in body
        or body == "@"
        or any(part.startswith(".") or part.endswith(".lock") for part in body.split("/"))
        or _UNSAFE_REF_BODY_RE.search(body)
    ):
        raise ValueError("invalid ref")
    return ref


def fetch_pr_head(
    repo_dir: Path,
    pr_number: int,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
    head_ref: str | None = None,
    head_sha: str | None = None,
    same_repo: bool = False,
) -> None:
    """Fetch the PR head, falling back to a verified same-repo branch.

    Immediately followed by ``git worktree add --detach FETCH_HEAD`` for PR
    review checkouts, so the head's tree blobs are backfilled the same way as
    :func:`fetch_ref`; without them the worktree-add triggers a promisor lazy
    fetch that fails under proxy-transport deployments (oh-my-pi#1818).

    Raises ``GitCommandError`` when fetching, SHA verification, or backfill fails.
    """
    if pr_number <= 0:
        raise ValueError(f"invalid pr_number={pr_number!r}")
    remote = remote_url or "origin"
    extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
    ref = f"refs/pull/{pr_number}/head" if remote_url else f"pull/{pr_number}/head"
    args = ["fetch", "--no-tags", remote, ref]
    try:
        _check(
            _run_git(
                args,
                cwd=repo_dir,
                token=token,
                auth_url=auth_url,
                extra_env=extra_env,
                safe_directory=safe_directory,
            ),
            ["git", *args],
        )
    except GitCommandError as exc:
        # The fallback fetches a branch named by the (webhook-supplied) PR
        # payload, so it is only eligible when we can verify the result:
        # same-repo PR, present head ref, present head SHA. Anything else
        # keeps the original failure.
        if (
            "couldn't find remote ref" not in exc.stderr
            or not same_repo
            or not head_ref
            or not head_sha
        ):
            raise
        validate_fetch_ref(head_ref)
        log.warning("PR head ref unavailable; fetching same-repo branch", extra={"pr": pr_number, "head_ref": head_ref})
        args = ["fetch", "--no-tags", remote, "--", f"refs/heads/{head_ref}"]
        try:
            _check(
                _run_git(
                    args,
                    cwd=repo_dir,
                    token=token,
                    auth_url=auth_url,
                    extra_env=extra_env,
                    safe_directory=safe_directory,
                ),
                ["git", *args],
            )
        except GitCommandError as fallback_exc:
            raise GitCommandError(
                fallback_exc.cmd,
                fallback_exc.returncode,
                fallback_exc.stdout,
                f"{exc.stderr}\nBranch fallback failed: {fallback_exc.stderr}",
            ) from fallback_exc
        probe_args = ["rev-parse", "FETCH_HEAD"]
        probe = _run_git(
            probe_args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=extra_env,
            safe_directory=safe_directory,
        )
        _check(probe, ["git", *probe_args])
        if probe.stdout.strip() != head_sha:
            raise GitCommandError(
                ["git", *probe_args],
                1,
                probe.stdout,
                f"PR head SHA mismatch: expected {head_sha}, fetched {probe.stdout.strip()}",
            )
    backfill = _backfill_tip_blobs(
        repo_dir,
        "FETCH_HEAD",
        remote,
        token=token,
        auth_url=auth_url,
        extra_env=extra_env,
        safe_directory=safe_directory,
    )
    if backfill is not None:
        _check(backfill, ["git", "fetch", "--stdin", remote])


@dataclass(slots=True, frozen=True)
class PushResult:
    head: str
    branch: str


@dataclass(slots=True, frozen=True)
class DirtyState:
    """Summary of the workspace's uncommitted + unpushed state.

    `uncommitted` counts entries from `git status --porcelain`. `unpushed`
    counts commits in `HEAD` not reachable from any `origin/*` ref — i.e.
    commits that would be lost if the workspace were thrown away. `summary`
    is a human-friendly multi-line description for embedding in a reminder
    prompt; empty when both counts are zero.
    """

    uncommitted: int
    unpushed: int
    summary: str

    @property
    def is_dirty(self) -> bool:
        return self.uncommitted > 0 or self.unpushed > 0


class HeadDriftError(GitCommandError):
    """Raised when `expected_head` no longer matches the current HEAD.

    Defends against an attacker landing a commit between the orchestrator's
    preflight gates and the actual push.
    """


def rev_parse_head(
    repo_dir: Path,
    *,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
) -> str:
    """Return the SHA of HEAD or raise GitCommandError."""
    args = ["rev-parse", "HEAD"]
    proc = _run_git(
        args,
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        user=user,
        group=group,
        extra_groups=extra_groups,
        umask=umask,
    )
    if proc.returncode != 0:
        raise GitCommandError(["git", *args], proc.returncode, proc.stdout, proc.stderr)
    return proc.stdout.strip()


def inspect_dirty_state(
    repo_dir: Path,
    *,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> DirtyState:
    """Probe the worktree at `repo_dir` for uncommitted/unpushed work.

    Returns a {@link DirtyState}. Errors from the underlying git invocations
    are swallowed — the caller treats "we couldn't tell" as clean so a broken
    git binary can't pin the agent in a reminder loop forever.
    """
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    uncommitted = 0
    uncommitted_sample: list[str] = []
    status = _run_git(
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        **slot_kwargs,
    )
    if status.returncode == 0 and status.stdout.strip():
        lines = status.stdout.splitlines()
        uncommitted = len(lines)
        uncommitted_sample = lines[:10]

    unpushed = 0
    unpushed_sample: list[str] = []
    count = _run_git(
        ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        **slot_kwargs,
    )
    if count.returncode == 0:
        try:
            unpushed = int(count.stdout.strip() or "0")
        except ValueError:
            unpushed = 0
    if unpushed > 0:
        log_proc = _run_git(
            ["log", f"--max-count={min(unpushed, 5)}", "--oneline", "HEAD", "--not", "--remotes=origin"],
            cwd=repo_dir,
            token=None,
            safe_directory=safe_directory,
            **slot_kwargs,
        )
        if log_proc.returncode == 0:
            unpushed_sample = [line for line in log_proc.stdout.splitlines() if line.strip()]

    if uncommitted == 0 and unpushed == 0:
        return DirtyState(uncommitted=0, unpushed=0, summary="")

    parts: list[str] = []
    if uncommitted:
        more = f"\n… and {uncommitted - len(uncommitted_sample)} more" if uncommitted > len(uncommitted_sample) else ""
        parts.append(f"Uncommitted changes ({uncommitted}):\n" + "\n".join(uncommitted_sample) + more)
    if unpushed:
        log_text = "\n".join(unpushed_sample) if unpushed_sample else "(no log available)"
        parts.append(f"Unpushed commits ({unpushed}):\n{log_text}")
    return DirtyState(uncommitted=uncommitted, unpushed=unpushed, summary="\n\n".join(parts))


def push(
    repo_dir: Path,
    *,
    branch: str,
    expected_head: str | None,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> PushResult:
    """Push `HEAD` with a lease, optionally to an explicit remote URL.

    The lease is pinned to whatever SHA the local `refs/remotes/origin/<branch>`
    currently records — i.e. what the workspace last fetched. The push only
    succeeds if origin's `<branch>` still matches that SHA, so a parallel
    writer to the same ref (between our last fetch and this push) is detected
    and refused even when the push is a fast-forward of HEAD. For a brand-new
    branch the local remote-tracking ref is absent, so the lease expects "no
    ref on origin" (empty expected value).

    `--force-with-lease` (vs plain `--force`) lets us recover from local
    history rewrites (e.g. the agent doing `git commit --amend --reset-author
    --no-edit` to fix author identity) while still refusing the push if origin
    has moved since our last fetch — i.e. it never clobbers work the bot
    didn't see.

    When `expected_head` is supplied, this verifies the *local* HEAD matches
    before pushing — anything else means an unexpected commit raced in inside
    our own worktree between the orchestrator's preflight and this call, and
    the push is aborted with `HeadDriftError`. This is a separate concern from
    `--force-with-lease`, which compares against the remote ref.
    """
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    git_safe_directory = safe_directory
    if git_safe_directory is None and slot_kwargs:
        git_safe_directory = repo_dir

    head = rev_parse_head(repo_dir, safe_directory=git_safe_directory, **slot_kwargs)
    if expected_head and head != expected_head:
        raise HeadDriftError(
            ["git", "push"],
            128,
            "",
            f"HEAD changed since preflight ({expected_head[:12]} → {head[:12]}); aborting push.",
        )
    # Probe the local remote-tracking ref. Missing → first push; we pin the
    # lease to the empty value so the push only succeeds if origin still has
    # no `<branch>`. Present → pin to that SHA.
    probe = _run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}"],
        cwd=repo_dir,
        token=None,
        safe_directory=git_safe_directory,
        **slot_kwargs,
    )
    expected_remote = probe.stdout.strip() if probe.returncode == 0 else ""
    if remote_url is None:
        push_extra_env: dict[str, str] | None = None
        origin = _run_git(
            ["remote", "get-url", "origin"], cwd=repo_dir, token=None, safe_directory=git_safe_directory, **slot_kwargs
        )
        if origin.returncode == 0:
            local_remote = _local_remote_safe_directory(origin.stdout, cwd=repo_dir)
            if local_remote is not None:
                push_extra_env = {}
                _append_safe_directory(push_extra_env, local_remote)
        destination = "origin"
        refspec = branch
        set_upstream = True
    else:
        push_extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
        destination = remote_url
        refspec = f"HEAD:refs/heads/{branch}"
        set_upstream = False
    lease = f"--force-with-lease=refs/heads/{branch}:{expected_remote}"
    args = ["push"]
    if token:
        args.append("--no-verify")
    args.append(lease)
    if set_upstream:
        args.append("--set-upstream")
    args.extend([destination, refspec])
    _check(
        _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=push_extra_env,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        ),
        ["git", *args],
    )
    if remote_url is not None:
        update = _run_git(
            ["update-ref", f"refs/remotes/origin/{branch}", head],
            cwd=repo_dir,
            token=None,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        )
        if update.returncode != 0:
            log.warning(
                "failed to refresh remote-tracking ref after explicit-url push",
                extra={"repo_dir": str(repo_dir), "branch": branch, "stderr": update.stderr[:500]},
            )
    return PushResult(head=head, branch=branch)


def push_release(
    repo_dir: Path,
    *,
    branch: str,
    tag: str,
    expected_head: str,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> PushResult:
    """Atomically push a release branch and force its tag to the same commit."""
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    git_safe_directory = safe_directory
    if git_safe_directory is None and slot_kwargs:
        git_safe_directory = repo_dir
    head = rev_parse_head(repo_dir, safe_directory=git_safe_directory, **slot_kwargs)
    if head != expected_head:
        raise HeadDriftError(
            ["git", "push"],
            128,
            "",
            f"HEAD changed since preflight ({expected_head[:12]} → {head[:12]}); aborting push.",
        )
    if remote_url is None:
        push_extra_env: dict[str, str] | None = None
        origin = _run_git(
            ["remote", "get-url", "origin"],
            cwd=repo_dir,
            token=None,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        )
        if origin.returncode == 0:
            local_remote = _local_remote_safe_directory(origin.stdout, cwd=repo_dir)
            if local_remote is not None:
                push_extra_env = {}
                _append_safe_directory(push_extra_env, local_remote)
        destination = "origin"
    else:
        push_extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
        destination = remote_url
    args = ["push", "--atomic"]
    if token:
        args.append("--no-verify")
    args.extend(
        [
            destination,
            f"refs/heads/{branch}:refs/heads/{branch}",
            f"+{expected_head}:refs/tags/{tag}",
        ]
    )
    _check(
        _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=push_extra_env,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        ),
        ["git", *args],
    )
    return PushResult(head=head, branch=branch)


__all__ = [
    "AUTH_ENV_VAR",
    "DirtyState",
    "GitCommandError",
    "HeadDriftError",
    "PushResult",
    "clone",
    "fetch_pr_head",
    "fetch_prune",
    "fetch_ref",
    "inspect_dirty_state",
    "push",
    "push_release",
    "redact_credentials",
    "rev_parse_head",
]
