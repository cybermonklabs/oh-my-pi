//! Adversarial tests for PR #17712 round 10: kill operand forms,
//! DISCARD propagation, pipeline last-stage control flow.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

static SCRIPT_RUNS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

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


async fn assert_rows(rows: &[(&str, &str, i32, &str)]) {
    let mut runs = tokio::task::JoinSet::new();
    for (index, &(_, script, _, _)) in rows.iter().enumerate() {
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
            let (id, script, expected_exit, expected) = rows[index];
            ((exit_code, output.as_str()) != (Some(expected_exit), expected)).then(|| {
                format!(
                    "{id}: `{script}`\n  bash: Some({expected_exit}) {expected:?}\n  omp:  {exit_code:?} {output:?}"
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

// ─── DISCARD propagation ─────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn adversarial_discard_propagation() {
    // Each expected value is from Bash 5.2.21 on the VM
    let rows: &[(&str, &str, i32, &str)] = &[
        (
            "discard/triple-nested",
            "{ set -o posix; readonly x=old; h(){ x=new /bin/true; echo in-h; }; g(){ h; echo in-g; }; f(){ g; echo in-f; }; f; echo after-all; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/case",
            "{ set -o posix; readonly x=old; case a in a) x=new /bin/true; echo in-case;; esac; echo after-case; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/arith-for",
            "{ set -o posix; readonly x=old; for ((i=0;i<3;i++)); do x=new /bin/true; echo i=$i; done; echo after-for; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/until",
            "{ set -o posix; readonly x=old; n=0; until [ $n -ge 2 ]; do n=$((n+1)); x=new /bin/true; echo n=$n; done; echo after-until; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/and-list",
            "{ set -o posix; readonly x=old; true && x=new /bin/true; echo same-line; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/or-list",
            "{ set -o posix; readonly x=old; false || x=new /bin/true; echo same-line; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/brace-in-fn",
            "{ set -o posix; readonly x=old; f(){ { x=new /bin/true; echo in-brace; }; echo after-brace; }; f; echo after-f; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/stmt-two-assigns",
            "{ readonly x=old; x=2; y=3; echo same; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/stmt-nested-eval",
            "{ readonly x=old; eval 'eval \"x=2; echo inner-eval\"; echo outer-eval'; echo after; } 2>/dev/null",
            0,
            "outer-eval\nafter\n",
        ),
        (
            "discard/prefix-before-function",
            "{ set -o posix; readonly x=old; f(){ echo in-f; }; x=new f; echo after-f; } 2>/dev/null",
            1,
            "",
        ),
        (
            "discard/trap-in-function",
            "{ readonly x=old; trap 'f(){ x=2; echo in-trap-f; }; f; echo in-trap' USR1; g(){ kill -USR1 $$; echo after-kill; }; g; echo after-g; } 2>/dev/null",
            0,
            "after-kill\nafter-g\n",
        ),
        (
            "discard/source",
            "{ d=$(mktemp -d); set -o posix; readonly x=old; printf 'x=new /bin/true; echo in-src1\\necho in-src2\\n' >\"$d/s.sh\"; . \"$d/s.sh\"; echo after-src; rm -rf \"$d\"; } 2>/dev/null",
            0,
            "in-src2\nafter-src\n",
        ),
        (
            "discard/non-posix-no-discard",
            "{ readonly x=old; x=new /bin/true; echo same-line; } 2>/dev/null",
            0,
            "same-line\n",
        ),
        // Bash exits with 127 here (POSIX readonly assignment stmt exits shell)
        (
            "discard/posix-stmt-exits",
            "{ set -o posix; readonly x=old; x=2; echo same; } 2>/dev/null",
            127,
            "",
        ),
        (
            "discard/posix-command-readonly-no-exit",
            "{ set -o posix; readonly x=old; command eval 'x=2'; echo same; } 2>/dev/null",
            0,
            "same\n",
        ),
        (
            "discard/background",
            "{ set -o posix; readonly x=old; f(){ x=new /bin/true; echo in-bg; }; f & wait $!; echo \"after s=$?\"; } 2>/dev/null",
            0,
            "after s=1\n",
        ),
    ];
    assert_rows(rows).await;
}

// ─── Pipeline control flow ───────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn adversarial_pipeline_control_flow() {
    let rows: &[(&str, &str, i32, &str)] = &[
        (
            "pipe/return-first",
            "f(){ return 42 | cat; echo \"in-f s=$?\"; }; f; echo \"after s=$?\"",
            0,
            "in-f s=0\nafter s=0\n",
        ),
        (
            "pipe/exit-middle",
            "echo start | exit 5 | cat; echo \"after s=$?\"",
            0,
            "after s=0\n",
        ),
        (
            "pipe/break-first",
            "for i in 1 2; do break | cat; echo i=$i; done; echo done",
            0,
            "i=1\ni=2\ndone\n",
        ),
        (
            "pipe/continue-first",
            "for i in 1 2; do continue | cat; echo i=$i; done; echo done",
            0,
            "i=1\ni=2\ndone\n",
        ),
        (
            "pipe/nested-break-levels",
            "for i in 1 2; do for j in a b; do true | break 2; echo j=$j; done; echo i=$i; done; echo done",
            0,
            "j=a\nj=b\ni=1\nj=a\nj=b\ni=2\ndone\n",
        ),
        (
            "pipe/return-last-non-lastpipe",
            "f(){ true | return 9; echo \"in-f s=$?\"; }; f; echo \"after-f s=$?\"",
            0,
            "in-f s=9\nafter-f s=0\n",
        ),
        (
            "pipe/exit-lastpipe",
            "shopt -s lastpipe; echo a | exit 7; echo should-not-reach",
            7,
            "",
        ),
        (
            "pipe/return-lastpipe",
            "shopt -s lastpipe; f(){ echo a | return 8; echo \"in-f-after s=$?\"; }; f; echo \"after-f s=$?\"",
            0,
            "after-f s=8\n",
        ),
        (
            "pipe/break-lastpipe",
            "shopt -s lastpipe; for i in 1 2; do echo a | break; echo i=$i; done; echo done-lastpipe",
            0,
            "done-lastpipe\n",
        ),
        (
            "pipe/continue-lastpipe",
            "shopt -s lastpipe; for i in 1 2; do echo a | continue; echo i=$i; done; echo done-lastpipe",
            0,
            "done-lastpipe\n",
        ),
        (
            "pipe/discard-middle",
            "{ set -o posix; readonly x=old; echo a | x=new /bin/true | cat; echo \"after s=$?\"; } 2>/dev/null",
            0,
            "after s=0\n",
        ),
        (
            "pipe/discard-last-non-lastpipe",
            "{ set -o posix; readonly x=old; echo a | x=new /bin/true; echo \"after s=$?\"; } 2>/dev/null",
            0,
            "after s=1\n",
        ),
    ];
    assert_rows(rows).await;
}
