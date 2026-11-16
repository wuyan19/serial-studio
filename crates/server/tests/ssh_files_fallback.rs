#![cfg(unix)]

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use russh::{
    server::{self, Auth, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::{File, Handle, Name, Status, StatusCode, Version};
use ss_server::ssh::{
    self,
    files::{execute, FileOperation, FileResult},
    SshAuthRecord, SshEndpointRecord, SshHostRecord,
};

#[derive(Clone, Copy)]
enum Mode {
    Reject,
    NoReply,
    BrokenInit,
    Sftp,
}
#[derive(Clone)]
struct FixtureServer {
    root: std::path::PathBuf,
    mode: Mode,
    execs: Arc<AtomicUsize>,
    channels: Arc<tokio::sync::Mutex<HashMap<ChannelId, Channel<server::Msg>>>>,
}
impl server::Handler for FixtureServer {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "fixture-password" {
            Auth::Accept
        } else {
            Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            }
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        _: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.mode {
            Mode::Reject => {
                session.channel_failure(id)?;
                session.close(id)?;
                self.channels.lock().await.remove(&id);
            }
            Mode::NoReply => {}
            Mode::BrokenInit => {
                session.channel_success(id)?;
                session.eof(id)?;
                session.close(id)?;
                self.channels.lock().await.remove(&id);
            }
            Mode::Sftp => {
                session.channel_success(id)?;
                let channel = self.channels.lock().await.remove(&id).unwrap();
                tokio::spawn(async move {
                    russh_sftp::server::run(channel.into_stream(), SftpFixture).await;
                });
            }
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.execs.fetch_add(1, Ordering::SeqCst);
        session.channel_success(id)?;
        let command = std::str::from_utf8(data).unwrap().to_owned();
        let channel = self.channels.lock().await.remove(&id).unwrap();
        let root = self.root.clone();
        let handle = session.handle();
        tokio::spawn(async move {
            use std::io::Write;
            use tokio::io::AsyncReadExt;
            let mut stream = channel.into_stream();
            let mut input = Vec::new();
            stream.read_to_end(&mut input).await.unwrap();
            let output = tokio::task::spawn_blocking(move || {
                let mut child = std::process::Command::new("sh")
                    .arg("-c")
                    .arg(command)
                    .current_dir(root)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap();
                let mut stdin = child.stdin.take().unwrap();
                let writer = std::thread::spawn(move || {
                    stdin.write_all(&input).unwrap();
                });
                let output = child.wait_with_output().unwrap();
                writer.join().unwrap();
                output
            })
            .await
            .unwrap();
            if !output.stdout.is_empty() {
                let _ = handle.data(id, output.stdout).await;
            }
            if !output.stderr.is_empty() {
                let _ = handle.extended_data(id, 1, output.stderr).await;
            }
            let _ = handle
                .exit_status_request(id, output.status.code().unwrap_or(1) as u32)
                .await;
            let _ = handle.eof(id).await;
            let _ = handle.close(id).await;
        });
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.lock().await.remove(&id);
        Ok(())
    }
}
struct SftpFixture;
impl russh_sftp::server::Handler for SftpFixture {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }
    async fn realpath(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy("/sftp-only")],
        })
    }
    async fn opendir(&mut self, id: u32, _: String) -> Result<Handle, Self::Error> {
        Ok(Handle {
            id,
            handle: "directory".into(),
        })
    }
    async fn readdir(&mut self, _: u32, _: String) -> Result<Name, Self::Error> {
        Err(StatusCode::Eof)
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}
async fn spawn(
    root: &std::path::Path,
    mode: Mode,
) -> (SshHostRecord, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let config = Arc::new(server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::ZERO,
        keys: vec![russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap()],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let execs = Arc::new(AtomicUsize::new(0));
    let fixture = FixtureServer {
        root: root.into(),
        mode,
        execs: execs.clone(),
        channels: Default::default(),
    };
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let config = config.clone();
            let fixture = fixture.clone();
            tokio::spawn(async move {
                let _ = server::run_stream(config, socket, fixture).await;
            });
        }
    });
    (
        SshHostRecord {
            id: format!("fixture-{port}"),
            host: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            nickname: None,
            auth: SshAuthRecord::Password {
                password: "fixture-password".into(),
            },
            endpoints: vec![SshEndpointRecord {
                name: "shell".into(),
                r#type: "shell".into(),
                alias: None,
            }],
        },
        execs,
        task,
    )
}
fn session(result: FileResult) -> (String, String) {
    match result {
        FileResult::Opened { session, path } => (session, path),
        _ => panic!("expected opened"),
    }
}

#[tokio::test]
async fn ssh_file_negotiation_preserves_auth_and_supports_shell_only_hosts() {
    let root = std::env::temp_dir().join(format!("ss-files-negotiation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::env::set_var("SERIAL_STUDIO_CONFIG_DIR", root.join("config"));
    let work = root.join("remote");
    std::fs::create_dir(&work).unwrap();
    std::fs::write(work.join("hello.txt"), b"hello over SSH\n").unwrap();
    let state = ss_server::create_state();
    for mode in [Mode::Reject, Mode::NoReply, Mode::BrokenInit, Mode::Sftp] {
        let (record, execs, task) = spawn(&work, mode).await;
        state.ssh.update_registry(vec![record.clone()]);
        let unknown = execute(&state, "test", &record.id, FileOperation::Open)
            .await
            .unwrap_err();
        assert!(!unknown.is_empty());
        assert_eq!(execs.load(Ordering::SeqCst), 0);
        let rec = record.clone();
        tokio::task::spawn_blocking(move || ssh::session::trust_host_key(rec))
            .await
            .unwrap()
            .unwrap();
        let mut bad = record.clone();
        bad.auth = SshAuthRecord::Password {
            password: "wrong".into(),
        };
        state.ssh.update_registry(vec![bad]);
        assert!(execute(&state, "test", &record.id, FileOperation::Open)
            .await
            .is_err());
        assert_eq!(execs.load(Ordering::SeqCst), 0);
        state.ssh.update_registry(vec![record.clone()]);
        let (token, path) = session(
            tokio::time::timeout(
                Duration::from_secs(12),
                execute(&state, "test", &record.id, FileOperation::Open),
            )
            .await
            .unwrap()
            .unwrap(),
        );
        match mode {
            Mode::Sftp => {
                assert_eq!(path, "/sftp-only");
                let listed = execute(
                    &state,
                    "test",
                    &record.id,
                    FileOperation::List {
                        session: token.clone(),
                        path: ".".into(),
                    },
                )
                .await
                .unwrap();
                match listed {
                    FileResult::Listed {
                        entries, protocol, ..
                    } => {
                        assert!(entries.is_empty());
                        assert_eq!(protocol.as_deref(), Some("sftp"));
                    }
                    _ => panic!("expected SFTP listing"),
                }
                assert_eq!(execs.load(Ordering::SeqCst), 0);
            }
            _ => {
                assert_eq!(std::path::Path::new(&path), work.canonicalize().unwrap());
                let listed = execute(
                    &state,
                    "test",
                    &record.id,
                    FileOperation::List {
                        session: token.clone(),
                        path: ".".into(),
                    },
                )
                .await
                .unwrap();
                match listed {
                    FileResult::Listed {
                        entries, protocol, ..
                    } => {
                        assert_eq!(protocol.as_deref(), Some("ssh"));
                        assert!(entries
                            .iter()
                            .any(|entry| entry.name == "hello.txt" && entry.kind == "file"));
                    }
                    _ => panic!("expected listing"),
                }
                let data = execute(
                    &state,
                    "test",
                    &record.id,
                    FileOperation::Read {
                        session: token.clone(),
                        path: work.join("hello.txt").to_string_lossy().into(),
                        offset: 0,
                        length: 65536,
                    },
                )
                .await
                .unwrap();
                match data {
                    FileResult::Data { data, .. } => {
                        assert_eq!(hex::decode(data).unwrap(), b"hello over SSH\n")
                    }
                    _ => panic!("expected read"),
                }
                if matches!(mode, Mode::Reject) {
                    let name = "literal ' $(touch PWN); 文件\n.bin";
                    let uploaded = work.join(name).to_string_lossy().into_owned();
                    let temporary = format!("{uploaded}.part");
                    let first: Vec<u8> = (0..65536).map(|i| (i % 251) as u8).collect();
                    for (offset, data, truncate) in
                        [(0, first.clone(), true), (65536, vec![255, 0, 17], false)]
                    {
                        execute(
                            &state,
                            "test",
                            &record.id,
                            FileOperation::Write {
                                session: token.clone(),
                                path: temporary.clone(),
                                offset,
                                data: hex::encode(data),
                                truncate,
                            },
                        )
                        .await
                        .unwrap();
                    }
                    execute(
                        &state,
                        "test",
                        &record.id,
                        FileOperation::Rename {
                            session: token.clone(),
                            from: temporary,
                            to: uploaded.clone(),
                        },
                    )
                    .await
                    .unwrap();
                    let mut expected = first;
                    expected.extend_from_slice(&[255, 0, 17]);
                    assert_eq!(std::fs::read(&uploaded).unwrap(), expected);
                    assert!(!work.join("PWN").exists());
                    let read = execute(
                        &state,
                        "test",
                        &record.id,
                        FileOperation::Read {
                            session: token.clone(),
                            path: uploaded.clone(),
                            offset: 65535,
                            length: 4,
                        },
                    )
                    .await
                    .unwrap();
                    match read {
                        FileResult::Data { data, .. } => {
                            assert_eq!(hex::decode(data).unwrap(), expected[65535..])
                        }
                        _ => panic!("expected binary read"),
                    }
                    execute(
                        &state,
                        "test",
                        &record.id,
                        FileOperation::Remove {
                            session: token.clone(),
                            path: uploaded,
                        },
                    )
                    .await
                    .unwrap();
                }
                assert!(execs.load(Ordering::SeqCst) > 0);
            }
        }
        execute(
            &state,
            "test",
            &record.id,
            FileOperation::Close { session: token },
        )
        .await
        .unwrap();
        task.abort();
    }
    std::env::remove_var("SERIAL_STUDIO_CONFIG_DIR");
    std::fs::remove_dir_all(root).unwrap();
}
