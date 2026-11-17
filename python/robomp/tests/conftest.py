"""Common pytest fixtures."""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Iterable, Mapping
from pathlib import Path

import pytest

from robomp.config import Settings, reset_settings_cache
from robomp.dashboard import reset_index_cache, static_dir
from robomp.db import Database, close_database

_GIT_CONFIG_SLOT = re.compile(r"GIT_CONFIG_(?:KEY|VALUE)_(\d+)")


@pytest.fixture(scope="session")
def _empty_xdg_config_home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("xdg-config")


@pytest.fixture(autouse=True)
def _no_inherited_git_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory, _empty_xdg_config_home: Path
) -> None:
    """Run every test without the shell's git environment or the machine's git config.

    Every inherited `GIT_*` variable is dropped: the `GIT_CONFIG_COUNT`/`KEY_<n>`/
    `VALUE_<n>` series (an agent session exports one), `GIT_CONFIG_PARAMETERS`
    (`git -c` hands it to git's children), `GIT_CONFIG`, and the variables that
    move git elsewhere (`GIT_DIR`, `GIT_INDEX_FILE`, which a git hook exports).
    The global and system config files are then replaced by an empty one, so
    `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and `/etc/gitconfig` are not
    read either. A test that needs git config sets it itself (`git_config`, or
    its own `GIT_CONFIG_SYSTEM`, after dropping `GIT_CONFIG_NOSYSTEM`).

    Git also reads `$XDG_CONFIG_HOME/git/ignore` and `attributes` (else under
    `~/.config/git/`) whatever `GIT_CONFIG_GLOBAL` says, so `XDG_CONFIG_HOME`
    names an empty directory. And a temp dir inside a git work tree would make
    git find that repository above a test's own dirs, so repository discovery
    stops at pytest's base temp dir.
    """
    for key in list(os.environ):
        if key.startswith("GIT_"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(_empty_xdg_config_home))
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path_factory.getbasetemp()))


# Included through an inherited channel, this file gives git a credential helper
# and an Authorization header, as a developer's or an agent session's config can.
_CREDENTIAL_INCLUDE = (
    '[credential "https://github.com/"]\n'
    "\thelper = !probe-helper\n"
    "[http]\n"
    "\textraHeader = Authorization: Basic PROBE-SECRET\n"
)


class GitConfigSeries:
    """Sets an inherited GIT_CONFIG_* series in os.environ and reads one back from an env."""

    # `user.name` in the `agent_home` fixture's own `~/.gitconfig`.
    AGENT_HOME_USER = "agent-home-user"

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._monkeypatch = monkeypatch

    def inherit(self, count: int, *, stale: Iterable[int] = ()) -> list[tuple[str, str]]:
        """Export ``count`` entries, plus stray slots ``stale`` past the count; return the entries."""
        entries = [(f"inherited.key{i}", f"value{i}") for i in range(count)]
        self._monkeypatch.setenv("GIT_CONFIG_COUNT", str(count))
        for i, (key, value) in enumerate(entries):
            self._monkeypatch.setenv(f"GIT_CONFIG_KEY_{i}", key)
            self._monkeypatch.setenv(f"GIT_CONFIG_VALUE_{i}", value)
        for i in stale:
            assert i >= count, "a stale slot lies past the count"
            self._monkeypatch.setenv(f"GIT_CONFIG_KEY_{i}", f"stale.key{i}")
            self._monkeypatch.setenv(f"GIT_CONFIG_VALUE_{i}", f"stale{i}")
        return entries

    @staticmethod
    def entries(env: Mapping[str, str]) -> list[tuple[str, str]]:
        """The entries git reads from ``env``, in order."""
        count = int(env.get("GIT_CONFIG_COUNT", "0"))
        return [(env[f"GIT_CONFIG_KEY_{i}"], env[f"GIT_CONFIG_VALUE_{i}"]) for i in range(count)]

    @staticmethod
    def past_count(env: Mapping[str, str]) -> dict[str, str]:
        """Non-empty GIT_CONFIG_KEY_<n>/VALUE_<n> slots of ``env`` at or past its count."""
        count = int(env.get("GIT_CONFIG_COUNT", "0"))
        return {
            key: value
            for key, value in env.items()
            if (match := _GIT_CONFIG_SLOT.fullmatch(key)) and int(match.group(1)) >= count and value
        }

    @staticmethod
    def credentials(env: Mapping[str, str], cwd: Path) -> list[str]:
        """The credential helpers and `http.extraHeader` values git reads under ``env``."""
        listed = subprocess.run(
            ["git", "config", "--list"], cwd=cwd, env=dict(env), capture_output=True, text=True, check=True
        ).stdout
        return [
            line for line in listed.splitlines() if line.partition("=")[0].lower().endswith((".helper", ".extraheader"))
        ]

    @staticmethod
    def get(env: Mapping[str, str], cwd: Path, key: str) -> str | None:
        """The value git reads for ``key`` under ``env``, or None."""
        got = subprocess.run(["git", "config", "--get", key], cwd=cwd, env=dict(env), capture_output=True, text=True)
        return got.stdout.strip() if got.returncode == 0 else None


@pytest.fixture
def git_config(monkeypatch: pytest.MonkeyPatch) -> GitConfigSeries:
    return GitConfigSeries(monkeypatch)


@pytest.fixture(
    params=[(1, ()), (3, ()), (1, (1, 4))],
    ids=["inherited-1", "inherited-3", "inherited-1-stale-1-4"],
)
def inherited_git_config(request: pytest.FixtureRequest, git_config: GitConfigSeries) -> list[tuple[str, str]]:
    """An inherited series of 1, of 3, and of 1 with stray slots 1 and 4 left past its count."""
    count, stale = request.param
    return git_config.inherit(count, stale=stale)


@pytest.fixture(
    params=[
        "series",
        "parameters",
        "home-gitconfig",
        "GIT_CONFIG_GLOBAL",
        "XDG_CONFIG_HOME",
        "home-xdg-default",
        "GIT_CONFIG_SYSTEM",
    ]
)
def operator_config_channel(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    """robomp's env gives git a credential helper through ``request.param``'s channel.

    robomp runs with an operator's HOME and, as a deployed robomp does, no
    `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` or `XDG_CONFIG_HOME` of its own;
    each channel then adds the config where it puts it: `GIT_CONFIG_COUNT`/
    `KEY_0`/`VALUE_0`, `GIT_CONFIG_PARAMETERS` (as `git -c` exports it),
    `$HOME/.gitconfig`, a `GIT_CONFIG_GLOBAL` file, `$XDG_CONFIG_HOME/git/config`,
    `$HOME/.config/git/config`, or a `GIT_CONFIG_SYSTEM` file.
    """
    channel = request.param
    home = tmp_path / "operator-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for key in ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "XDG_CONFIG_HOME"):
        monkeypatch.delenv(key, raising=False)
    credentials = tmp_path / "credentials.gitconfig"
    credentials.write_text(_CREDENTIAL_INCLUDE, encoding="utf-8")

    def plant(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_CREDENTIAL_INCLUDE, encoding="utf-8")

    if channel == "series":
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", "include.path")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", str(credentials))
    elif channel == "parameters":
        monkeypatch.setenv("GIT_CONFIG_PARAMETERS", f"'include.path'='{credentials}'")
    elif channel == "home-gitconfig":
        plant(home / ".gitconfig")
    elif channel == "GIT_CONFIG_GLOBAL":
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(credentials))
    elif channel == "XDG_CONFIG_HOME":
        plant(home / ".config-elsewhere" / "git" / "config")
        monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config-elsewhere"))
    elif channel == "home-xdg-default":
        plant(home / ".config" / "git" / "config")
    elif channel == "GIT_CONFIG_SYSTEM":
        monkeypatch.delenv("GIT_CONFIG_NOSYSTEM")
        monkeypatch.setenv("GIT_CONFIG_SYSTEM", str(credentials))
    return channel


@pytest.fixture(params=["no-agent-home", "agent-home"])
def agent_home(request: pytest.FixtureRequest, tmp_path: Path) -> Path:
    """The agent home robomp would use: missing, or present with its own `~/.gitconfig`."""
    home = tmp_path / "agent-home"
    if request.param == "agent-home":
        home.mkdir()
        user = GitConfigSeries.AGENT_HOME_USER
        (home / ".gitconfig").write_text(f"[user]\n\tname = {user}\n", encoding="utf-8")
    return home


# Minimum HTML the dashboard handler needs to render: `<title>` plus a script
# block carrying the `__ROBOMP_CONFIG__` sentinel. The real Vite-built bundle
# adds JS/CSS asset links; tests only care about the rendering contract.
_PLACEHOLDER_INDEX_HTML = (
    "<!doctype html>\n"
    '<html lang="en">\n'
    '  <head><meta charset="utf-8"><title>robomp</title></head>\n'
    "  <body>\n"
    '    <div id="app"></div>\n'
    '    <script id="robomp-config" type="application/json">__ROBOMP_CONFIG__</script>\n'
    "  </body>\n"
    "</html>\n"
)


@pytest.fixture(autouse=True, scope="session")
def _ensure_dashboard_bundle() -> None:
    """Guarantee a renderable dashboard bundle for the whole session.

    The real bundle is produced by `bun run web:build`; CI and fresh clones
    might not have run it yet. We only synthesise an `index.html` when one
    isn't already present, so a developer's locally-built bundle isn't
    clobbered by the test run.
    """
    directory = static_dir()
    index = directory / "index.html"
    if not index.exists():
        index.write_text(_PLACEHOLDER_INDEX_HTML, encoding="utf-8")
    reset_index_cache()


@pytest.fixture(autouse=True)
def _open_tmp_path_for_slot_traversal(tmp_path: Path) -> None:
    """Grant traverse (`+x`) on tmp_path's root-owned ancestors so slot
    subprocesses can reach the workspace.

    pytest's default ``tmp_path`` lives under ``/tmp/pytest-of-<user>/`` with
    mode ``0700``. On macOS dev that's irrelevant (no slot subprocess ever
    drops uid). On Linux+root the slot UID (e.g. 2001) is non-zero and
    every directory between ``/`` and the workspace needs at least the
    `o+x` bit or the slot's stat fails with EACCES. Adds `o+x` (NOT `o+r`)
    so directory contents stay private; only path-traversal is allowed.
    """
    import os
    import platform
    import stat

    if platform.system() != "Linux" or os.geteuid() != 0:
        return
    cursor = tmp_path.resolve()
    while cursor != cursor.parent:
        try:
            st = cursor.stat()
        except FileNotFoundError:
            break
        if not stat.S_ISDIR(st.st_mode):
            break
        if not (st.st_mode & 0o001):
            try:
                cursor.chmod(st.st_mode | 0o001)
            except PermissionError:
                break
        cursor = cursor.parent


def _baseline_env(tmp_path: Path) -> dict[str, str]:
    return {
        # Orchestrator-mode: no PAT in this container; talk to gh-proxy instead.
        "ROBOMP_GH_PROXY_URL": "http://gh-proxy.invalid:8081",
        "ROBOMP_GH_PROXY_HMAC_KEY": "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "GITHUB_WEBHOOK_SECRET": "test-webhook-secret",
        "ROBOMP_BOT_LOGIN": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_NAME": "robomp-bot",
        "ROBOMP_GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "ROBOMP_REPO_ALLOWLIST": "octo/widget",
        "ROBOMP_MODEL": "anthropic/claude-sonnet-4-5",
        "ROBOMP_THINKING": "high",
        "ROBOMP_WORKSPACE_ROOT": str(tmp_path / "workspaces"),
        "ROBOMP_SQLITE_PATH": str(tmp_path / "robomp.sqlite"),
        "ROBOMP_LOG_DIR": str(tmp_path / "logs"),
        # Production default is `/data/cache/pi-natives` (provisioned by the
        # container entrypoint). Tests need a writable, isolated path; we also
        # default-disable the cache so its background GC loop doesn't add
        # noise to event-dispatcher timing assertions. Tests that want the
        # cache flip `ROBOMP_NATIVES_CACHE_ENABLED=true` explicitly.
        "ROBOMP_NATIVES_CACHE_ROOT": str(tmp_path / "natives-cache"),
        "ROBOMP_NATIVES_CACHE_ENABLED": "false",
        # Same reasoning for the issue-index reconciler: its first tick would
        # spin connect-retries against the .invalid proxy URL inside server
        # tests. Tests that want it construct IssueIndexSync directly.
        "ROBOMP_ISSUE_INDEX_SYNC_SECONDS": "0",
    }


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    env = _baseline_env(tmp_path)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    # Defensive: a stray `.env` or shell export must not flip us into PAT mode.
    # `monkeypatch.delenv` would let pydantic_settings fall back to the .env
    # file; setenv("") is what actually shadows the file value, and the
    # `_blank_token_disables` validator treats empty strings as unset.
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield env
    reset_settings_cache()
    close_database()


@pytest.fixture
def proxy_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    """Baseline env for the gh-proxy container: holds the PAT, no proxy vars."""
    baseline = _baseline_env(tmp_path)
    baseline.pop("ROBOMP_GH_PROXY_URL", None)
    baseline.pop("ROBOMP_GH_PROXY_HMAC_KEY", None)
    baseline["GITHUB_TOKEN"] = "ghp_test_token_value_xxxxxxxxxxxxxxxx"
    for key, value in baseline.items():
        monkeypatch.setenv(key, value)
    # Same defense-in-depth as `env`: setenv("") rather than delenv so
    # pydantic_settings doesn't fall back to the on-disk `.env` file.
    monkeypatch.setenv("ROBOMP_GH_PROXY_URL", "")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "")
    monkeypatch.delenv("ROBOMP_PROVIDER", raising=False)
    monkeypatch.setenv("ROBOMP_REPLAY_TOKEN", "")
    reset_settings_cache()
    yield baseline
    reset_settings_cache()
    close_database()


@pytest.fixture
def settings(env: dict[str, str]) -> Settings:
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()
    return cfg


@pytest.fixture
def db(tmp_path: Path) -> Database:
    path = tmp_path / "test.sqlite"
    database = Database(path)
    yield database
    database.close()
