use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

pub struct Backend {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    sequence: AtomicU64,
    stopped: AtomicBool,
}
impl Backend {
    pub fn start(app: &AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let project = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let runtime = if cfg!(debug_assertions) {
            project.to_path_buf()
        } else {
            app.path().resource_dir()?.join("runtime")
        };
        let node = if cfg!(debug_assertions) {
            std::path::PathBuf::from("node")
        } else {
            runtime.join(if cfg!(windows) { "node.exe" } else { "node" })
        };
        let mut command = Command::new(node);
        command
            // Node rejects Windows verbatim paths; resolve the entry relative to its working directory.
            .arg("main.cjs")
            .current_dir(&runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        let output = child.stdout.take().unwrap();
        let backend = Arc::new(Self {
            input: Mutex::new(child.stdin.take().unwrap()),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
        });
        let reader = backend.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                if let Some(id) = message["id"].as_u64() {
                    if let Some(sender) = reader.pending.lock().unwrap().remove(&id) {
                        let result = if let Some(error) = message["error"].as_str() {
                            Err(error.to_owned())
                        } else {
                            Ok(message["value"].clone())
                        };
                        let _ = sender.send(result);
                    }
                } else if let Some(event) = message["event"].as_str() {
                    if event == "meeting-restore" {
                        super::restore(&app);
                    } else if ["meeting-state", "meeting-audio"].contains(&event) {
                        let _ = app.emit(event, &message["value"]);
                    }
                }
            }
            reader.kill();
            super::restore(&app);
            for (_, sender) in reader.pending.lock().unwrap().drain() {
                let _ = sender.send(Err(
                    "Meeting backend stopped. Restart the app; pending audio is retained.".into(),
                ));
            }
            let _ = app.emit(
                "meeting-fatal",
                "Meeting backend stopped. Restart the app to recover pending audio.",
            );
        });
        Ok(backend)
    }
    pub async fn call(&self, method: &str, args: Vec<Value>) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) = writeln!(
            self.input.lock().unwrap(),
            "{}",
            json!({"id":id,"method":method,"args":args})
        ) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error.to_string());
        }
        let response = tokio::time::timeout(Duration::from_secs(660), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        response
            .map_err(|_| "Meeting operation timed out.".to_owned())?
            .map_err(|_| "Meeting backend stopped.".to_owned())?
    }
    pub fn kill(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut child = self.child.lock().unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .status();
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", "--", &format!("-{}", child.id())])
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
