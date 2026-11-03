//! Adversarial tests: kill on jobs started under one job-control setting,
//! signalled under another. Expected values from Bash 5.2.21.
#![cfg(target_os = "linux")]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

static SCRIPT_RUNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

async fn run_in(shell: &Shell, command: &str) -> (Option<i32>, String) {
    let (tx, rx) = flume::unbounded::<String>();
    let result = shell
        .run(
            ShellRunOptions { command: command.to_owned(), ..Default::default() },
            Some(tx),
            CancelToken::new(Some(60_000)),
        )
        .await
        .expect("run");
    let output: String = rx.drain().collect();
    dump_row(std::ptr::from_ref(shell) as usize, command, result.exit_code, &output);
    (result.exit_code, output)
}

fn dump_row(shell_id: usize, command: &str, exit_code: Option<i32>, output: &str) {
	use std::io::Write;
	if let Ok(path) = std::env::var("PHASEA_DUMP") {
		let test = std::thread::current().name().unwrap_or("").to_owned();
		let line = serde_json::json!({"file": file!(), "test": test, "shell": shell_id, "script": command, "exit": exit_code, "output": output});
		let mut f = std::fs::OpenOptions::new().create(true).append(true).open(format!("{path}.{}", std::process::id())).expect("dump");
		f.write_all(format!("{line}\n").as_bytes()).expect("dump write");
	}
}


async fn assert_rows(rows: &[(&str, &str, &str)]) {
    let mut runs = tokio::task::JoinSet::new();
    for (index, &(_, script, _)) in rows.iter().enumerate() {
        let script = script.to_owned();
        runs.spawn(async move {
            let _permit = SCRIPT_RUNS.acquire().await.expect("run limit");
            (index, run_in(&Shell::new(None), &script).await)
        });
    }
    let mut results = runs.join_all().await;
    results.sort_unstable_by_key(|&(index, _)| index);
    let mismatches: Vec<String> = results
        .into_iter()
        .filter_map(|(index, (exit_code, output))| {
            let (id, script, expected) = rows[index];
            ((exit_code, output.as_str()) != (Some(0), expected)).then(|| {
                format!(
                    "{id}: `{script}`\n  bash: Some(0) {expected:?}\n  omp:  {exit_code:?} {output:?}"
                )
            })
        })
        .collect();
    assert!(
        mismatches.is_empty(),
        "{} of {} rows differ:\n{}",
        mismatches.len(),
        rows.len(),
        mismatches.join("\n")
    );
}

const STATE: &str = r#"st(){ s=dead; if [ -r "/proc/$1/stat" ]; then read -r _ _ s _ <"/proc/$1/stat"; [ "$s" = Z ] && s=dead; fi; echo "$s"; }; "#;
const SETTLE: &str = r#"/bin/sleep .3; i=0; while [ $i -lt 300 ]; do sa=$(st $a); case "$sa" in dead|T) break;; esac; /bin/sleep .01; i=$((i+1)); done; "#;
const CLEAN: &str = r#"/bin/kill -KILL "$a" 2>/dev/null; wait 2>/dev/null; cd /; rm -rf "$d""#;

/// Test kill on jobs started under one job-control setting, signalled under another.
/// Bash's `IS_JOBCONTROL` is set from how the job was started, not the current `set -m`.
#[tokio::test(flavor = "multi_thread")]
async fn kill_mixed_job_control_settings() {
    let rows: &[(&str, &str, &str)] = &[
        // Start with -m (job control), switch to +m, kill %1 with TERM
        // Job was started with job control → uses group signal path → SIGCONT follows
        // → the stopped job wakes and gets TERM → process dies
        (
            "start-m/signal+m/kill-%1-TERM",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set -m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; jobs >/dev/null; set +m; kill -TERM %1 2>/dev/null; echo "kill=$?"; {SETTLE}echo "a=$(st $a)"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\na=dead\n",
        ),
        // Start with -m, switch to +m, kill -- -$pgid with TERM
        (
            "start-m/signal+m/kill-neg-TERM",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set -m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; jobs >/dev/null; set +m; kill -TERM -- -$a 2>/dev/null; echo "kill=$?"; {SETTLE}echo "a=$(st $a)"; ran=no; [ -s ran ] && ran=yes; echo "ran=$ran"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\na=dead\nran=no\n",
        ),
        // Start with +m (no job control), switch to -m, kill %1 with TERM
        // Job was started WITHOUT job control → per-pid signal path → TERM to stopped process stays
        (
            "start+m/signal-m/kill-%1-TERM",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set +m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; set -m; kill -TERM %1 2>/dev/null; echo "kill=$?"; {SETTLE}echo "a=$(st $a)"; ran=no; [ -s ran ] && ran=yes; echo "ran=$ran"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\na=T\nran=no\n",
        ),
        // Start with +m, switch to -m, kill $pid with TERM (plain pid always by pid alone)
        (
            "start+m/signal-m/kill-pid-TERM",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set +m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; set -m; kill -TERM $a 2>/dev/null; echo "kill=$?"; {SETTLE}echo "a=$(st $a)"; ran=no; [ -s ran ] && ran=yes; echo "ran=$ran"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\na=T\nran=no\n",
        ),
        // Kill -CONT on a job started with -m but signalled after +m
        // started_with_job_control=true → group CONT → process resumes
        (
            "start-m/signal+m/kill-%1-CONT",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set -m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; jobs >/dev/null; set +m; kill -CONT %1 2>/dev/null; echo "kill=$?"; /bin/sleep .3; i=0; while [ $i -lt 300 ]; do [ "$(st $a)" = dead ] && break; /bin/sleep .01; i=$((i+1)); done; ran=no; [ -s ran ] && ran=yes; echo "ran=$ran"; echo "a=$(st $a)"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\nran=ran\na=dead\n",
        ),
        // Kill -CONT on a job started with +m but signalled after -m
        // started_with_job_control=false → per-pid CONT → process resumes
        (
            "start+m/signal-m/kill-%1-CONT",
            &format!(r#"{{ d=$(mktemp -d); cd "$d"; {STATE}set +m; /bin/sh -c 'echo $$ >p1; kill -STOP $$; echo ran >ran' & p=$!; until [ -s p1 ]; do /bin/sleep .01; done; read a <p1; until [ "$(st $a)" = T ]; do /bin/sleep .01; done; set -m; kill -CONT %1 2>/dev/null; echo "kill=$?"; /bin/sleep .3; i=0; while [ $i -lt 300 ]; do [ "$(st $a)" = dead ] && break; /bin/sleep .01; i=$((i+1)); done; ran=no; [ -s ran ] && ran=yes; echo "ran=$ran"; echo "a=$(st $a)"; {CLEAN}; }} 2>/dev/null"#),
            "kill=0\nran=ran\na=dead\n",
        ),
    ];
    assert_rows(rows).await;
}
