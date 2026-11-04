use super::super::session::HostKeyChecker;
use super::{FileEntry, FileOperation, FileResult};
use russh::{client::Handle, ChannelMsg};

const MAX_LIST_BYTES: usize = 8 * 1024 * 1024;
const PREFIX: &str = r#"LC_ALL=C; export LC_ALL
fail() { printf '%s\n' "$1" >&2; exit 1; }
absolute() { case "$p" in /*) ;; *) p=./$p ;; esac; }
regular() { [ ! -L "$p" ] && [ -f "$p" ] || fail 'Not a regular file'; }
attributes() { a=$(stat -c '%s %Y' "$p" 2>/dev/null) || a=$(stat -f '%z %m' "$p" 2>/dev/null) || fail 'Cannot stat file'; }
metadata() {
  if [ -L "$p" ]; then kind=symlink; elif [ -d "$p" ]; then kind=directory; elif [ -f "$p" ]; then kind=file; else kind=other; fi
  attributes
  set -- $a
  [ "$#" = 2 ] || fail 'Unsupported stat output'
  printf '%s\000%s\000%s\000%s\000' "$name" "$kind" "$1" "$2"
}
"#;

struct Command {
    script: String,
    input: Vec<u8>,
    limit: usize,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command(script: &str, args: &[&str], input: Vec<u8>, limit: usize) -> Command {
    let assignments = args
        .iter()
        .map(|arg| quote(arg))
        .collect::<Vec<_>>()
        .join(" ");
    Command {
        script: format!("{PREFIX}\nset -- {assignments}\n{script}"),
        input,
        limit,
    }
}
const PROBE: &str = r#"for tool in stat dd mkdir mv rm; do command -v "$tool" >/dev/null 2>&1 || fail "Missing command: $tool"; done
p=.; attributes
cd -P . || exit 1
printf '%s\000' "$PWD"
"#;
fn plan(operation: FileOperation) -> Result<Command, String> {
    Ok(match operation {
        FileOperation::List { path, .. } => command(r#"p=$1; absolute
cd -P "$p" || exit 1
printf '%s\000' "$PWD"
n=0
for p in "$PWD"/* "$PWD"/.[!.]* "$PWD"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  n=$((n+1)); [ "$n" -le 10000 ] || fail 'Directory exceeds 10000 entries'
  name=${p##*/}; metadata
done
"#, &[&path], vec![], MAX_LIST_BYTES),
        FileOperation::Stat { path, .. } => command("p=$1; absolute; name=${p##*/}; metadata\n", &[&path], vec![], 8192),
        FileOperation::Read { path, offset, length, .. } => {
            if length == 0 || length > 65536 { return Err("读取块大小无效".into()); }
            // Read aligned blocks so BusyBox seeks efficiently and avoids byte-sized reads.
            let skip = offset / 32768;
            let prefix = offset as usize % 32768;
            let count = (prefix + length as usize + 32767) / 32768;
            let script = format!("p=$1; absolute; regular\ndd if=\"$p\" bs=32768 skip={skip} count={count}\n");
            command(&script, &[&path], vec![], count * 32768)
        }
        FileOperation::Write { path, offset, data, truncate, .. } => {
            if data.len() > 131072 { return Err("写入块过大".into()); }
            let input = hex::decode(data).map_err(|_| "上传编码无效")?;
            let init = if truncate { "[ ! -L \"$p\" ] && { [ ! -e \"$p\" ] || [ -f \"$p\" ]; } || fail 'Not a regular file'\n: >\"$p\" || exit 1\n" } else { "regular\n" };
            let (size, seek) = if offset % 32768 == 0 { (32768, offset / 32768) } else { (1, offset) };
            let script = format!("p=$1; absolute\n{init}dd of=\"$p\" bs={size} seek={seek} conv=notrunc\n");
            command(&script, &[&path], input, 0)
        }
        FileOperation::Mkdir { path, .. } => command("p=$1; absolute\n[ ! -L \"$p\" ] || fail 'Symbolic link is not a directory target'\n[ -d \"$p\" ] || mkdir \"$p\"\n", &[&path], vec![], 0),
        FileOperation::Rename { from, to, .. } => command("p=$1; absolute; regular; source=$p\np=$2; absolute\n[ ! -L \"$p\" ] && [ ! -d \"$p\" ] || fail 'Cannot replace a directory or symbolic link'\nmv -f \"$source\" \"$p\"\n", &[&from, &to], vec![], 0),
        FileOperation::Remove { path, .. } => command("p=$1; absolute; regular\nrm \"$p\"\n", &[&path], vec![], 0),
        _ => return Err("SSH 兼容模式不支持此文件操作".into()),
    })
}
async fn run(ssh: &Handle<HostKeyChecker>, command: Command) -> Result<Vec<u8>, String> {
    let mut channel = ssh
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, command.script.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    if !command.input.is_empty() {
        channel
            .data(&command.input[..])
            .await
            .map_err(|e| e.to_string())?;
    }
    channel.eof().await.map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                if output.len() + data.len() > command.limit {
                    let _ = channel.close().await;
                    return Err("远端文件输出超过限制".into());
                }
                output.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, .. } => {
                let remaining = 16384usize.saturating_sub(errors.len());
                errors.extend_from_slice(&data[..remaining.min(data.len())]);
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            ChannelMsg::Failure => {
                let _ = channel.close().await;
                return Err("远端拒绝 SSH 文件命令".into());
            }
            ChannelMsg::Close => break,
            _ => (),
        }
    }
    if status != Some(0) {
        let detail = String::from_utf8_lossy(&errors).trim().to_owned();
        return Err(if detail.is_empty() {
            "SSH 文件命令未成功完成".into()
        } else {
            detail
        });
    }
    Ok(output)
}
fn text(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "远端文件名或路径不是 UTF-8".into())
}
fn fields(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    if !bytes.ends_with(&[0]) {
        return Err("SSH 文件元数据格式无效".into());
    }
    Ok(bytes[..bytes.len() - 1].split(|b| *b == 0).collect())
}
fn parse_entry(values: &[&[u8]]) -> Result<FileEntry, String> {
    if values.len() != 4 {
        return Err("SSH 文件元数据格式无效".into());
    }
    Ok(FileEntry {
        name: text(values[0])?,
        kind: text(values[1])?,
        size: text(values[2])?.parse().map_err(|_| "文件大小无效")?,
        modified: text(values[3])?.parse().ok(),
    })
}
pub(super) async fn probe(ssh: &Handle<HostKeyChecker>) -> Result<String, String> {
    let output = run(ssh, command(PROBE, &[], vec![], 8192)).await?;
    let values = fields(&output)?;
    if values.len() != 1 {
        return Err("SSH 返回了无效的工作目录".into());
    }
    let path = text(values[0])?;
    if !path.starts_with('/') {
        return Err("SSH 返回了无效的工作目录".into());
    }
    Ok(path)
}
pub(super) async fn execute(
    ssh: &Handle<HostKeyChecker>,
    operation: FileOperation,
) -> Result<FileResult, String> {
    let plan = plan(operation.clone())?;
    let output = run(ssh, plan).await?;
    decode(operation, &output)
}
fn decode(operation: FileOperation, output: &[u8]) -> Result<FileResult, String> {
    Ok(match operation {
        FileOperation::List { .. } => {
            let values = fields(output)?;
            if (values.len() - 1) % 4 != 0 || values.len() > 40001 {
                return Err("SSH 目录响应无效".into());
            }
            let entries = values[1..]
                .chunks_exact(4)
                .map(parse_entry)
                .collect::<Result<Vec<_>, _>>()?;
            FileResult::Listed {
                path: text(values[0])?,
                entries,
                protocol: Some("ssh".into()),
            }
        }
        FileOperation::Stat { .. } => FileResult::Stat {
            entry: parse_entry(&fields(output)?)?,
        },
        FileOperation::Read { offset, length, .. } => {
            let start = (offset as usize % 32768).min(output.len());
            let data = &output[start..(start + length as usize).min(output.len())];
            FileResult::Data {
                data: hex::encode(data),
                eof: data.len() < length as usize,
            }
        }
        _ => FileResult::Ok,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Write,
        path::PathBuf,
        process::{Command as Process, Stdio},
    };
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("ss-shell-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().into()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn local(command: Command) -> Result<Vec<u8>, String> {
        let mut child = Process::new("/bin/sh")
            .arg("-c")
            .arg(command.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&command.input)
            .unwrap();
        let output = child.wait_with_output().unwrap();
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into());
        }
        assert!(output.stdout.len() <= command.limit);
        Ok(output.stdout)
    }
    fn perform(operation: FileOperation) -> Result<FileResult, String> {
        let output = local(plan(operation.clone())?)?;
        decode(operation, &output)
    }
    #[test]
    fn shell_probe_and_directory_metadata_preserve_special_names() {
        let fixture = Fixture::new();
        let name = "a 'quoted'\n$(touch SENTINEL) ;.txt";
        fs::write(fixture.path(name), b"content").unwrap();
        fs::create_dir(fixture.path("empty folder")).unwrap();
        let cwd = local(command(PROBE, &[], vec![], 8192)).unwrap();
        assert_eq!(fields(&cwd).unwrap().len(), 1);
        let FileResult::Listed {
            entries, protocol, ..
        } = perform(FileOperation::List {
            session: "".into(),
            path: fixture.path(""),
        })
        .unwrap()
        else {
            panic!()
        };
        assert_eq!(protocol.as_deref(), Some("ssh"));
        assert!(entries
            .iter()
            .any(|e| e.name == name && e.kind == "file" && e.size == 7));
        assert!(entries
            .iter()
            .any(|e| e.name == "empty folder" && e.kind == "directory"));
        assert!(!fixture.0.join("SENTINEL").exists());
        let FileResult::Stat { entry } = perform(FileOperation::Stat {
            session: "".into(),
            path: fixture.path(name),
        })
        .unwrap() else {
            panic!()
        };
        assert_eq!(entry.name, name);
        assert_eq!(entry.size, 7);
    }
    #[test]
    fn binary_reads_use_bounded_aligned_blocks_with_correct_offsets() {
        let fixture = Fixture::new();
        let path = fixture.path("binary.bin");
        let bytes: Vec<u8> = (0..160000).map(|i| (i % 251) as u8).collect();
        fs::write(&path, &bytes).unwrap();
        for (offset, length) in [
            (0, 65536),
            (32767, 65536),
            (98301, 65536),
            (159999, 4),
            (200000, 10),
        ] {
            let FileResult::Data { data, eof } = perform(FileOperation::Read {
                session: "".into(),
                path: path.clone(),
                offset,
                length,
            })
            .unwrap() else {
                panic!()
            };
            let expected = &bytes[(offset as usize).min(bytes.len())
                ..(offset as usize + length as usize).min(bytes.len())];
            assert_eq!(hex::decode(data).unwrap(), expected);
            assert_eq!(eof, expected.len() < length as usize);
        }
    }
    #[test]
    fn uploads_accept_binary_stdin_and_publish_by_rename() {
        let fixture = Fixture::new();
        let temporary = fixture.path("upload 'file'\n.part");
        let target = fixture.path("target");
        let bytes: Vec<u8> = (0..65536).map(|i| (i % 256) as u8).collect();
        for (offset, data, truncate) in [(0, bytes.clone(), true), (65536, vec![0, 255, 10], false)]
        {
            perform(FileOperation::Write {
                session: "".into(),
                path: temporary.clone(),
                offset,
                data: hex::encode(data),
                truncate,
            })
            .unwrap();
        }
        fs::write(&target, b"original").unwrap();
        perform(FileOperation::Rename {
            session: "".into(),
            from: temporary.clone(),
            to: target.clone(),
        })
        .unwrap();
        let mut expected = bytes;
        expected.extend([0, 255, 10]);
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert!(!PathBuf::from(temporary).exists());
        perform(FileOperation::Write {
            session: "".into(),
            path: fixture.path("empty"),
            offset: 0,
            data: "".into(),
            truncate: true,
        })
        .unwrap();
        assert_eq!(fs::metadata(fixture.path("empty")).unwrap().len(), 0);
    }
    #[test]
    fn file_operations_reject_directories_and_preserve_failed_rename_source() {
        let fixture = Fixture::new();
        let folder = fixture.path("folder");
        let file = fixture.path("file");
        perform(FileOperation::Mkdir {
            session: "".into(),
            path: folder.clone(),
        })
        .unwrap();
        perform(FileOperation::Mkdir {
            session: "".into(),
            path: folder.clone(),
        })
        .unwrap();
        fs::write(&file, b"original").unwrap();
        assert!(perform(FileOperation::Read {
            session: "".into(),
            path: folder.clone(),
            offset: 0,
            length: 1
        })
        .is_err());
        assert!(perform(FileOperation::Remove {
            session: "".into(),
            path: folder.clone()
        })
        .is_err());
        assert!(perform(FileOperation::Rename {
            session: "".into(),
            from: file.clone(),
            to: folder
        })
        .is_err());
        assert_eq!(fs::read(&file).unwrap(), b"original");
        perform(FileOperation::Remove {
            session: "".into(),
            path: file.clone(),
        })
        .unwrap();
        assert!(!PathBuf::from(file).exists());
    }
    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_listed_but_never_read_written_or_used_as_directories() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.path("target");
        let link = fixture.path("link");
        fs::write(&target, b"keep").unwrap();
        symlink(&target, &link).unwrap();
        let FileResult::Stat { entry } = perform(FileOperation::Stat {
            session: "".into(),
            path: link.clone(),
        })
        .unwrap() else {
            panic!()
        };
        assert_eq!(entry.kind, "symlink");
        assert!(perform(FileOperation::Read {
            session: "".into(),
            path: link.clone(),
            offset: 0,
            length: 1
        })
        .is_err());
        assert!(perform(FileOperation::Write {
            session: "".into(),
            path: link.clone(),
            offset: 0,
            data: "61".into(),
            truncate: true
        })
        .is_err());
        assert!(perform(FileOperation::Mkdir {
            session: "".into(),
            path: link
        })
        .is_err());
        assert_eq!(fs::read(target).unwrap(), b"keep");
    }
    #[test]
    fn malformed_metadata_and_oversized_chunks_are_rejected() {
        assert!(fields(b"missing terminator").is_err());
        assert!(parse_entry(&[b"name", b"file", b"not-size", b"0"]).is_err());
        assert!(plan(FileOperation::Read {
            session: "".into(),
            path: "/a".into(),
            offset: 0,
            length: 65537
        })
        .is_err());
        assert!(plan(FileOperation::Write {
            session: "".into(),
            path: "/a".into(),
            offset: 0,
            data: "ff".repeat(65537),
            truncate: true
        })
        .is_err());
    }
}
