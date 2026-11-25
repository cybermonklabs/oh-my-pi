/**
 * The generation a window returns for a session with no token (see `READ_WINDOW_SCRIPT` in
 * redis-session-storage.ts): an earlier version wrote it last. A module of its own, so the
 * package root, which re-exports redis-session-storage.ts, does not export it.
 */
export const UNVERSIONED = "?";
